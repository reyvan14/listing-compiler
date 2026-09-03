"""Structured canvas-operation plans for the station Agent.

The Agent never mutates the canvas. It proposes a *plan* — a small, strictly
typed list of operations — which the client validates again and applies inside
one editor transaction after the user approves it.

Two hard rules shape this module:

1. **Nothing executable crosses the wire.** Operations are data with an
   allow-listed ``type``; there is no field anywhere that carries code, a shell
   command, a URL to fetch, or a function body. A malformed or unknown
   operation is dropped, never "best-effort" interpreted.

2. **Product copy and evidence text are data, not instructions.** They are
   handed to the model inside a delimited block that the system prompt marks as
   untrusted, and no text from them can widen what the plan may do — the schema
   is the only thing that decides that.

The deterministic planner below is not a demo shim: it is the same schema and
the same client-side validator as the model path, so an unavailable model
degrades the *wording*, never the safety envelope.
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Any

# --------------------------------------------------------------------------- #
# Schema                                                                       #
# --------------------------------------------------------------------------- #

NODE_TYPES = ("sku_listing", "image_generation", "video_generation")
OPERATION_TYPES = ("create_node", "update_node", "connect_nodes", "focus_nodes", "run_nodes")

#: Ceilings. A plan that wants more than this is refused outright rather than
#: truncated — a half-applied intent is worse than a rejected one.
MAX_OPERATIONS = 24
MAX_CREATED_NODES = 8
MAX_PROMPT_CHARS = 600
MAX_TEXT_CHARS = 2000
MAX_FIELDS_PER_OP = 20

IMAGE_RATIOS = ("1:1", "16:9", "9:16", "4:3", "3:4", "3:2")
VIDEO_RATIOS = ("9:16", "16:9", "1:1")
VIDEO_DURATIONS = ("5s", "10s", "15s")
PLATFORMS = ("amazon", "tiktok", "shopify")

#: Only these fields may be written, per node type. Anything else is rejected —
#: the model cannot reach result arrays, spawned ids or internal bookkeeping.
WRITABLE_FIELDS: dict[str, dict[str, str]] = {
    "sku_listing": {
        "productName": "str",
        "points": "text",
        "amazon": "bool",
        "tiktok": "bool",
        "shopify": "bool",
    },
    "image_generation": {
        "prompt": "prompt",
        "aspectRatio": "image_ratio",
        "name": "str",
        "count": "count",
    },
    "video_generation": {
        "prompt": "prompt",
        "aspectRatio": "video_ratio",
        "duration": "duration",
        "platform": "str",
        "count": "count",
    },
}


class PlanError(ValueError):
    """A plan that cannot be trusted. The message is safe to show a user."""


def _clean_text(value: Any, limit: int) -> str:
    text = str(value if value is not None else "")
    # Collapse control characters; they have no place in a node field and are a
    # cheap vector for confusing downstream rendering.
    text = "".join(ch for ch in text if ch == "\n" or ch >= " ")
    return text[:limit]


def _validate_field(node_type: str, key: str, value: Any) -> Any:
    kinds = WRITABLE_FIELDS[node_type]
    kind = kinds.get(key)
    if kind is None:
        raise PlanError(f"{node_type} 不接受字段 {key}")
    if kind == "bool":
        if not isinstance(value, bool):
            raise PlanError(f"{key} 必须是布尔值")
        return value
    if kind == "count":
        if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= 4:
            raise PlanError(f"{key} 必须是 1–4 的整数")
        return value
    if kind == "image_ratio":
        if value not in IMAGE_RATIOS:
            raise PlanError(f"图片比例 {value} 不受支持")
        return value
    if kind == "video_ratio":
        if value not in VIDEO_RATIOS:
            raise PlanError(f"视频比例 {value} 不受支持")
        return value
    if kind == "duration":
        if value not in VIDEO_DURATIONS:
            raise PlanError(f"视频时长 {value} 不受支持")
        return value
    if kind == "prompt":
        return _clean_text(value, MAX_PROMPT_CHARS)
    if kind == "text":
        return _clean_text(value, MAX_TEXT_CHARS)
    return _clean_text(value, 200)


def _validate_fields(node_type: str, raw: Any) -> dict[str, Any]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise PlanError("fields 必须是对象")
    if len(raw) > MAX_FIELDS_PER_OP:
        raise PlanError("单个操作的字段过多")
    return {key: _validate_field(node_type, key, value) for key, value in raw.items()}


def _validate_position(raw: Any) -> "dict[str, float] | None":
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise PlanError("position 必须是对象")
    try:
        x, y = float(raw["x"]), float(raw["y"])
    except (KeyError, TypeError, ValueError):
        raise PlanError("position 需要数值 x / y") from None
    if not all(abs(v) < 100_000 for v in (x, y)):
        raise PlanError("position 超出画布范围")
    return {"x": x, "y": y}


_ID_RE = re.compile(r"^[A-Za-z0-9:_-]{1,80}$")


def _validate_ref(value: Any, what: str) -> str:
    text = str(value or "")
    if not _ID_RE.match(text):
        raise PlanError(f"{what} 不是合法的节点引用")
    return text


def validate_operation(raw: Any) -> dict[str, Any]:
    """One operation, or raise. Unknown types are refused, never coerced."""
    if not isinstance(raw, dict):
        raise PlanError("操作必须是对象")
    op_type = raw.get("type")
    if op_type not in OPERATION_TYPES:
        raise PlanError(f"不支持的操作类型：{op_type}")

    if op_type == "create_node":
        node_type = raw.get("nodeType")
        if node_type not in NODE_TYPES:
            raise PlanError(f"不支持的节点类型：{node_type}")
        return {
            "type": "create_node",
            "tempId": _validate_ref(raw.get("tempId"), "tempId"),
            "nodeType": node_type,
            "fields": _validate_fields(node_type, raw.get("fields")),
            "position": _validate_position(raw.get("position")),
        }

    if op_type == "update_node":
        node_type = raw.get("nodeType")
        if node_type not in NODE_TYPES:
            # update needs the type to know which fields are writable; without
            # it we cannot validate the payload at all.
            raise PlanError("update_node 需要 nodeType 才能校验字段")
        return {
            "type": "update_node",
            "nodeId": _validate_ref(raw.get("nodeId"), "nodeId"),
            "nodeType": node_type,
            "fields": _validate_fields(node_type, raw.get("fields")),
        }

    if op_type == "connect_nodes":
        src, dst = raw.get("from"), raw.get("to")
        if not isinstance(src, dict) or not isinstance(dst, dict):
            raise PlanError("connect_nodes 需要 from / to 对象")
        return {
            "type": "connect_nodes",
            "from": {
                "nodeId": _validate_ref(src.get("nodeId"), "from.nodeId"),
                "portId": _validate_ref(src.get("portId"), "from.portId"),
            },
            "to": {
                "nodeId": _validate_ref(dst.get("nodeId"), "to.nodeId"),
                "portId": _validate_ref(dst.get("portId"), "to.portId"),
            },
        }

    ids = raw.get("nodeIds")
    if not isinstance(ids, list) or not ids:
        raise PlanError(f"{op_type} 需要 nodeIds 数组")
    if len(ids) > MAX_CREATED_NODES * 2:
        raise PlanError(f"{op_type} 的节点数量超过上限")
    return {
        "type": op_type,
        "nodeIds": [_validate_ref(i, "nodeIds[]") for i in ids],
    }


def validate_plan(raw: Any) -> dict[str, Any]:
    """A whole plan, or raise. Never partially accepts."""
    if not isinstance(raw, dict):
        raise PlanError("计划必须是对象")
    ops_raw = raw.get("operations")
    if not isinstance(ops_raw, list) or not ops_raw:
        raise PlanError("计划里没有任何操作")
    if len(ops_raw) > MAX_OPERATIONS:
        raise PlanError(f"操作数量超过上限（{MAX_OPERATIONS}）")

    operations = [validate_operation(op) for op in ops_raw]

    created = sum(1 for op in operations if op["type"] == "create_node")
    if created > MAX_CREATED_NODES:
        raise PlanError(f"新建节点数量超过上限（{MAX_CREATED_NODES}）")

    temp_ids = {op["tempId"] for op in operations if op["type"] == "create_node"}
    if len(temp_ids) != created:
        raise PlanError("tempId 重复")

    warnings_raw = raw.get("warnings") or []
    if not isinstance(warnings_raw, list):
        raise PlanError("warnings 必须是数组")
    warnings = [_clean_text(w, 200) for w in warnings_raw if str(w or "").strip()][:10]

    estimated_calls = raw.get("estimatedModelCalls", 0)
    if isinstance(estimated_calls, bool) or not isinstance(estimated_calls, int):
        raise PlanError("estimatedModelCalls 必须是整数")
    if not 0 <= estimated_calls <= 50:
        raise PlanError("estimatedModelCalls 超出范围")
    runs = [op for op in operations if op["type"] == "run_nodes"]
    if runs and estimated_calls == 0:
        estimated_calls = 1

    return {
        "id": _clean_text(raw.get("id") or f"plan-{uuid.uuid4().hex[:10]}", 60),
        "title": _clean_text(raw.get("title") or "画布操作计划", 80),
        "summary": _clean_text(raw.get("summary") or "", 600),
        "estimatedModelCalls": estimated_calls,
        "warnings": warnings,
        # Any plan that runs anything needs the second confirmation, whatever
        # the model claimed.
        "requiresRunConfirmation": bool(runs) or bool(raw.get("requiresRunConfirmation")),
        "operations": operations,
    }


# --------------------------------------------------------------------------- #
# Deterministic planner                                                        #
#                                                                              #
# Used when Token Plan is unavailable, and as the safety net when the model    #
# returns something unusable. It emits the SAME schema and goes through the    #
# SAME client validator — there is no privileged path for fallback plans.      #
# --------------------------------------------------------------------------- #

#: Canvas geometry for laid-out plans. Left-to-right dependency flow: the SKU
#: compiler on the left, its image branch next, video downstream of that. These
#: positions are anchored to the live SKU; the client frames the changed group.
_COL_SKU = 36
_COL_IMAGE = 470
_COL_VIDEO = 900
_ROW_TOP = 36
_ROW_STEP = 360


#: A topic word alone must never produce a plan — "主图能加字吗" is a question
#: about main images, not a request to build one. A plan is only proposed when
#: the text also carries an action.
_ACTION_WORDS = (
    "创建", "新建", "搭建", "建立", "添加", "加一个", "加个", "帮我做", "做一套",
    "生成", "接到", "连接", "连到", "删除", "移除", "去掉", "修复", "重跑",
    "重新生成", "重新跑", "改成", "设置", "配置", "create", "build", "add",
    "connect", "remove", "delete", "fix", "rerun", "regenerate",
)

#: Questions stay questions even when they contain an action word.
_QUESTION_MARKERS = ("吗", "呢", "？", "?", "如何", "怎么", "为什么", "是不是", "能不能")


def _has_action(text: str) -> bool:
    t = (text or "").lower()
    if not any(word in t for word in _ACTION_WORDS):
        return False
    # "怎么创建一个图片节点" is guidance-seeking; "创建一个图片节点" is a request.
    if any(marker in t for marker in _QUESTION_MARKERS):
        return any(k in t for k in ("请", "帮我", "给我"))
    return True


def _intent(text: str) -> set[str]:
    """Coarse intent tags. Deliberately keyword-based and inspectable."""
    t = (text or "").lower()
    tags: set[str] = set()
    if any(k in t for k in ("完整", "全流程", "工作流", "上新流程", "workflow")):
        tags.add("full_workflow")
    if "amazon" in t or "亚马逊" in t:
        tags.add("amazon")
    if "tiktok" in t or "抖音" in t:
        tags.add("tiktok")
    if "shopify" in t:
        tags.add("shopify")
    if any(k in t for k in ("视频", "短视频", "video", "15 秒", "15秒")):
        tags.add("video")
    if any(k in t for k in ("白底", "主图", "white background")):
        tags.add("white_bg")
    if any(k in t for k in ("场景图", "生活图", "lifestyle", "9:16")):
        tags.add("lifestyle")
    if "bpa" in t:
        tags.add("bpa")
    if any(k in t for k in ("证据", "无证据", "evidence", "宣称")):
        tags.add("evidence")
    if any(k in t for k in ("删除", "移除", "remove", "去掉")):
        tags.add("remove")
    if any(k in t for k in ("失败", "报错", "修复", "repair", "failed")):
        tags.add("repair")
    if any(k in t for k in ("规则更新", "政策", "policy", "重新生成", "迁移")):
        tags.add("policy")
    if any(k in t for k in ("连接", "connect", "接到")):
        tags.add("connect")
    return tags


def is_canonical_full_workflow_request(text: str) -> bool:
    """Whether the user selected the audited three-platform workflow template.

    This intentionally matches only the product's named quick action, not every
    free-form request that happens to mention a workflow. The named action is a
    stable UI contract: it must always produce the complete, tested topology
    instead of depending on a model to rediscover its four required branches.
    """
    normalized = re.sub(r"\s+", "", (text or "").lower())
    named_template = any(
        phrase in normalized
        for phrase in ("三平台完整工作流", "三台完整上新工作流")
    )
    return named_template and _has_action(text)


def _evidence_warnings(context: dict[str, Any]) -> list[str]:
    """Turn the evidence summary into plain warnings the plan card can show."""
    summary = (context or {}).get("evidenceSummary") or {}
    out: list[str] = []
    conflicting = int(summary.get("conflicting") or 0)
    unsupported = int(summary.get("unsupported") or 0)
    needs_review = int(summary.get("needsReview") or 0)
    if conflicting:
        out.append(f"{conflicting} 条事实来源冲突，依赖它们的字段会被发布闸门阻断。")
    if unsupported:
        out.append(f"{unsupported} 条宣称没有证据支撑，不会被自动写成已核实。")
    if needs_review:
        out.append(f"{needs_review} 条事实已提取但待人工确认。")
    return out


def _sku_node(context: dict[str, Any]) -> "dict[str, Any] | None":
    for node in (context or {}).get("nodes") or []:
        if node.get("type") == "sku_listing":
            return node
    return None


def _upload_count(context: dict[str, Any]) -> int:
    sku = _sku_node(context) or {}
    fields = sku.get("editableFields") or {}
    try:
        return int(fields.get("uploadCount") or 0)
    except (TypeError, ValueError):
        return 0


def _full_workflow_plan(text: str, context: dict[str, Any], tags: set[str]) -> dict[str, Any]:
    """The primary demo: images per platform, a video branch, all wired up."""
    sku = _sku_node(context)
    ops: list[dict[str, Any]] = []
    creates: list[str] = []

    explicit_platforms = tags & {"amazon", "tiktok", "shopify"}
    all_platforms = "full_workflow" in tags and not explicit_platforms
    want_amazon = "amazon" in tags or all_platforms or not explicit_platforms
    want_tiktok = "tiktok" in tags or all_platforms
    want_shopify = "shopify" in tags or all_platforms
    want_video = want_tiktok and ("video" in tags or "full_workflow" in tags)

    # Anchor generated branches to the live SKU instead of fixed global
    # coordinates. A moved SKU therefore cannot make a new plan land back on
    # top of the station origin. Three platform assets form readable lanes;
    # TikTok video continues to the right of its scene image.
    position = (sku or {}).get("position") or {}
    try:
        sku_x = float(position.get("x", _COL_SKU))
        sku_y = float(position.get("y", _ROW_TOP))
        if not (-99_000 < sku_x < 99_000 and -99_000 < sku_y < 99_000):
            raise ValueError
    except (TypeError, ValueError):
        sku_x, sku_y = _COL_SKU, _ROW_TOP
    image_x = sku_x + 440
    video_x = image_x + 440
    row_top = sku_y
    balanced_full = want_amazon and want_tiktok and want_shopify and want_video

    sku_ref = sku["id"] if sku else "sku1"
    sku_fields = {
        "amazon": bool(want_amazon),
        "tiktok": bool(want_tiktok),
        "shopify": bool(want_shopify),
    }
    if sku:
        ops.append(
            {
                "type": "update_node",
                "nodeId": sku_ref,
                "nodeType": "sku_listing",
                "fields": sku_fields,
            }
        )
    else:
        ops.append(
            {
                "type": "create_node",
                "tempId": sku_ref,
                "nodeType": "sku_listing",
                "fields": sku_fields,
                "position": {"x": sku_x, "y": sku_y},
            }
        )
        creates.append(sku_ref)

    row = 0
    if want_amazon:
        ops.append(
            {
                "type": "create_node",
                "tempId": "img_amazon",
                "nodeType": "image_generation",
                "fields": {
                    "name": "Amazon 白底主图",
                    "aspectRatio": "1:1",
                    "prompt": (
                        "折叠硅胶旅行杯，纯白背景（RGB 255,255,255），正面 45 度，"
                        "主体占画面 85%，柔和棚拍光，无文字、无 logo、无边框、无水印。"
                    ),
                },
                "position": {"x": image_x, "y": row_top + row * _ROW_STEP},
            }
        )
        ops.append(
            {
                "type": "connect_nodes",
                "from": {"nodeId": sku_ref, "portId": "output"},
                "to": {"nodeId": "img_amazon", "portId": "input"},
            }
        )
        creates.append("img_amazon")
        row += 1

    if want_tiktok:
        ops.append(
            {
                "type": "create_node",
                "tempId": "img_tiktok",
                "nodeType": "image_generation",
                "fields": {
                    "name": "TikTok 场景图",
                    "aspectRatio": "9:16",
                    "prompt": (
                        "折叠硅胶旅行杯的生活场景竖版图：清晨通勤桌面或步道休息点，"
                        "自然光，手持或随身携带，真实质感，无促销文字。"
                    ),
                },
                "position": {"x": image_x, "y": row_top + row * _ROW_STEP},
            }
        )
        ops.append(
            {
                "type": "connect_nodes",
                "from": {"nodeId": sku_ref, "portId": "output"},
                "to": {"nodeId": "img_tiktok", "portId": "input"},
            }
        )
        creates.append("img_tiktok")

        if want_video:
            ops.append(
                {
                    "type": "create_node",
                    "tempId": "vid_tiktok",
                    "nodeType": "video_generation",
                    "fields": {
                        # video_generation has no `name` field — see mediaStation.
                        "aspectRatio": "9:16",
                        "duration": "15s",
                        "platform": "TikTok",
                        "prompt": (
                            "15 秒竖版短视频：从口袋取出折叠杯并展开，倒水、盖盖、"
                            "轻微倒置展示防漏，最后折回收纳。自然光，无口播促销字幕。"
                        ),
                    },
                    "position": {"x": video_x, "y": row_top + row * _ROW_STEP},
                }
            )
            # the scene image becomes the video's first frame
            ops.append(
                {
                    "type": "connect_nodes",
                    "from": {"nodeId": "img_tiktok", "portId": "output"},
                    "to": {"nodeId": "vid_tiktok", "portId": "input"},
                }
            )
            creates.append("vid_tiktok")
        row += 1

    if want_shopify:
        ops.append(
            {
                "type": "create_node",
                "tempId": "img_shopify",
                "nodeType": "image_generation",
                "fields": {
                    "name": "Shopify 品牌生活图",
                    "aspectRatio": "4:3",
                    "prompt": (
                        "折叠硅胶旅行杯的品牌站生活图：桌面静物或旅行场景，"
                        "品牌调性，允许非白底，无促销文字。"
                    ),
                },
                "position": {
                    "x": video_x if balanced_full else image_x,
                    "y": row_top if balanced_full else row_top + row * _ROW_STEP,
                },
            }
        )
        ops.append(
            {
                "type": "connect_nodes",
                "from": {"nodeId": sku_ref, "portId": "output"},
                "to": {"nodeId": "img_shopify", "portId": "input"},
            }
        )
        creates.append("img_shopify")

    warnings = _evidence_warnings(context)
    uploads = _upload_count(context)
    if uploads == 0:
        warnings.append("SKU 节点还没有上传产品图；生图会走纯文本提示词。")
    if "evidence" in tags or "证据" in (text or ""):
        warnings.append("发布闸门仍会独立校验每条宣称，无证据的宣称不会被放行。")

    # Running from the SKU root reuses the existing execution graph, which
    # generates the three platform listings first and then walks each media
    # branch. Merely applying the plan still does not run anything.
    ops.append({"type": "run_nodes", "nodeIds": [sku_ref]})

    platforms = [
        name
        for name, want in (("Amazon", want_amazon), ("TikTok Shop", want_tiktok), ("Shopify", want_shopify))
        if want
    ]
    created_nodes = len(creates)
    return {
        "title": "创建完整上新工作流",
        "summary": (
            f"为 {('、'.join(platforms)) or '所选平台'} 准备上新：新建 {created_nodes} 个节点"
            f"，建立 {sum(1 for o in ops if o['type'] == 'connect_nodes')} 条连接。"
            "只写入节点字段，不会触发任何生成。"
        ),
        "estimatedModelCalls": 1 + sum(
            1 for o in ops if o["type"] == "create_node" and o["nodeType"] != "sku_listing"
        ),
        "warnings": warnings,
        "requiresRunConfirmation": True,
        "operations": ops,
    }


def _remove_unsupported_claim_plan(context: dict[str, Any]) -> "dict[str, Any] | None":
    """Strip an unsupported claim from the SKU truth source.

    Only the SKU selling points are edited: that is where the operator asserted
    the claim. Nothing is regenerated here — the plan says which platforms would
    need a rerun and leaves that to a separate confirmation.
    """
    sku = _sku_node(context)
    if not sku:
        return None
    points = str((sku.get("editableFields") or {}).get("points") or "")
    if not points:
        return None
    kept = [
        line
        for line in points.split("\n")
        if "bpa" not in line.lower() and "不含bpa" not in line.replace(" ", "").lower()
    ]
    if len(kept) == len(points.split("\n")):
        return None

    return {
        "title": "移除无证据支撑的 BPA-Free 宣称",
        "summary": (
            "从 SKU 卖点中删除 BPA-Free 一行。该宣称在证据账本里没有任何支撑，"
            "发布闸门会阻断依赖它的字段。删除后需要重新生成受影响的平台文案。"
        ),
        "estimatedModelCalls": 0,
        "warnings": [
            "只改动 SKU 真相源，不会自动重跑任何平台；重跑需要单独确认。",
            "如果你有支撑该宣称的证书，更好的做法是上传证据而不是删除宣称。",
        ],
        "requiresRunConfirmation": False,
        "operations": [
            {
                "type": "update_node",
                "nodeId": sku["id"],
                "nodeType": "sku_listing",
                "fields": {"points": "\n".join(kept)},
            }
        ],
    }


def _connect_selected_plan(context: dict[str, Any]) -> "dict[str, Any] | None":
    """Wire a selected image node into a selected (or new) video node."""
    selected = set((context or {}).get("selectedNodeIds") or [])
    nodes = {n["id"]: n for n in (context or {}).get("nodes") or []}
    images = [i for i in selected if nodes.get(i, {}).get("type") == "image_generation"]
    videos = [i for i in selected if nodes.get(i, {}).get("type") == "video_generation"]
    if not images:
        return None

    ops: list[dict[str, Any]] = []
    target = videos[0] if videos else "vid_new"
    if not videos:
        ops.append(
            {
                "type": "create_node",
                "tempId": target,
                "nodeType": "video_generation",
                "fields": {
                    "aspectRatio": "9:16",
                    "duration": "15s",
                    "prompt": "以上游图片为首帧的 15 秒竖版短视频，自然光，无促销字幕。",
                },
                "position": {"x": _COL_VIDEO, "y": _ROW_TOP},
            }
        )
    ops.append(
        {
            "type": "connect_nodes",
            "from": {"nodeId": images[0], "portId": "output"},
            "to": {"nodeId": target, "portId": "input"},
        }
    )
    return {
        "title": "把所选图片接到视频节点",
        "summary": "所选图片将作为视频节点的首帧输入。不会触发生成。",
        "estimatedModelCalls": 0,
        "warnings": [],
        "requiresRunConfirmation": False,
        "operations": ops,
    }


def _repair_plan(context: dict[str, Any]) -> "dict[str, Any] | None":
    """Targeted repair for the first failed / blocked node."""
    broken = [
        n
        for n in (context or {}).get("nodes") or []
        if n.get("status") in ("error", "blocked")
    ]
    if not broken:
        return None
    node = broken[0]
    reason = _clean_text(node.get("lastError") or "该节点未成功产出。", 200)
    return {
        "title": "修复失败节点并只重跑受影响分支",
        "summary": (
            f"节点 {node.get('type')} 报告：{reason} "
            "计划只重跑该节点及其下游，未受影响的节点保持原样。"
        ),
        "estimatedModelCalls": 1,
        "warnings": ["重跑会调用模型，可能产生费用。"],
        "requiresRunConfirmation": True,
        "operations": [
            {"type": "focus_nodes", "nodeIds": [node["id"]]},
            {"type": "run_nodes", "nodeIds": [node["id"]]},
        ],
    }


def deterministic_plan(text: str, context: dict[str, Any]) -> "dict[str, Any] | None":
    """A plan for *text*, or None when no supported intent is recognised.

    Returns None for questions: the Agent answers those in prose. A plan is a
    proposal to change the canvas, and offering one for "主图能加字吗" would be
    noise at best and a mis-click risk at worst.
    """
    if not _has_action(text):
        return None
    tags = _intent(text)
    context = context or {}

    if "repair" in tags:
        plan = _repair_plan(context)
        if plan:
            return plan
    if "remove" in tags and ("bpa" in tags or "evidence" in tags):
        plan = _remove_unsupported_claim_plan(context)
        if plan:
            return plan
    if "connect" in tags:
        plan = _connect_selected_plan(context)
        if plan:
            return plan
    if tags & {"full_workflow", "amazon", "tiktok", "shopify", "white_bg", "lifestyle", "video"}:
        return _full_workflow_plan(text, context, tags)
    return None


def plan_reply(plan: dict[str, Any]) -> str:
    """The chat line that accompanies a plan. Never claims anything was done."""
    created = sum(1 for o in plan["operations"] if o["type"] == "create_node")
    updated = sum(1 for o in plan["operations"] if o["type"] == "update_node")
    links = sum(1 for o in plan["operations"] if o["type"] == "connect_nodes")
    bits = []
    if created:
        bits.append(f"新建 {created} 个节点")
    if updated:
        bits.append(f"更新 {updated} 个节点")
    if links:
        bits.append(f"建立 {links} 条连接")
    detail = "、".join(bits) or "调整画布"
    return f"我拟了一个方案：{detail}。请在下方查看，确认后才会写入画布。"


def extract_plan_json(raw: str) -> "dict[str, Any] | None":
    """Pull a plan object out of a model reply. Returns None on anything odd."""
    text = (raw or "").strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        text = fence.group(1).strip()
    start = text.find("{")
    if start == -1:
        return None
    try:
        data = json.loads(text[start:])
    except (json.JSONDecodeError, ValueError):
        return None
    return data if isinstance(data, dict) else None
