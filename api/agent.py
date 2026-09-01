from __future__ import annotations

from typing import Any

from generate import LLM_BASE, LLM_KEY, LLM_MODEL, _chat_completions

SYSTEM = """你是「跨境上架编译器」的助手。
工位只做上架前检查，不自动上架、不担保过审、不登广告账户。
三台：Amazon 货架、TikTok Shop 货架（连着内容）、Shopify 品牌站。投放条不是第四个上新台。
检查三态：能贴 / 需改 / 只能去投放。BPA-Free 无证书标「需改」。
Amazon / TikTok Shop 商品主图偏白底无加字；Shopify 不强制白底。
演示 SKU：折叠硅胶水杯 350ml。
用简体中文回答。不要说已发布。不要编造证书。
可以解释规则、改标题、改生图提示词。"""


def fallback_reply(text: str) -> str:
    t = text.lower()
    if "bpa" in t or "证书" in text:
        return "BPA-Free 没有证书就标「需改」，不要写成「能贴」。工位不担保过审。"
    if "主图" in text or "白底" in text:
        return "Amazon / TikTok Shop 商品主图偏白底、不要加字。Shopify 不强制白底。带字竖版只能去品牌站或投放。"
    if "提示词" in text or "生图" in text:
        return "写清主体、背景、比例。货架主图写白底静物，不要促销字。需要我按折叠硅胶水杯 350ml 拟一条吗？"
    if "上架" in text or "广告" in text:
        return "这里不自动上架，也不登广告账户。投放条只下载文案，不会标「已发布」。"
    return "我在右侧。可以问三台规则、帮你改提示词或标题。不自动上架，不登广告账户。"


async def agent_reply(messages: list[dict[str, Any]]) -> str:
    cleaned: list[dict[str, str]] = []
    for item in messages[-12:]:
        role = item.get("role")
        content = str(item.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            cleaned.append({"role": role, "content": content})
    if not cleaned:
        return "直接问上新规则，或把提示词贴过来。"
    if not LLM_BASE or not LLM_KEY:
        return fallback_reply(cleaned[-1]["content"])
    try:
        url = LLM_BASE if LLM_BASE.endswith("/chat/completions") else f"{LLM_BASE}/chat/completions"
        return await _chat_completions(
            url,
            {"Content-Type": "application/json", "Authorization": f"Bearer {LLM_KEY}"},
            {
                "model": LLM_MODEL,
                "stream": False,
                "messages": [{"role": "system", "content": SYSTEM}, *cleaned],
            },
            40.0,
        )
    except Exception as exc:
        print(f"[agent] llm skipped: {type(exc).__name__}: {exc!r}", flush=True)
        return fallback_reply(cleaned[-1]["content"])
