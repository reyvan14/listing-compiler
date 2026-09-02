# 产品口径定稿

产品名称：跨境上架编译器

定位：**跨境上架编译器——面向商品与平台双重漂移的自愈式 Listing CI/CD**

参赛场景：场景 1「AI 智能上新」

阶段：创意初赛原型

## 一句话

输入一次 SKU 品名、卖点、平台选择和图片，生成 Amazon、TikTok Shop、Shopify 三套字段化草稿及检查结果；
当 SKU 事实或平台政策发生变化时，系统计算精确影响面、把受影响产物标记为「已过期」、在不覆盖已批准内容的前提下
构建候选补丁，并支持逐项批准与回滚。运营复核后自行到平台后台提交。

## 当前产品结构

- 前端：Vite + React + tldraw 单页画布。
- 节点：`sku_listing`、`listing_result`、`image_generation`、`video_generation`。
- 后端：FastAPI。核心接口 `POST /api/listing/generate`；迁移工作流见下。
- 文本：upstream → Token Plan（OpenAI 兼容 chat）→ `fallback_drafts` 三级降级。
- 规则：`api/policy/snapshots/*.yaml` 版本化、可执行的政策包；`/api/rules` 由「当前」快照拼装，保持向后兼容。
- 图片 / 视频：兼容旧供应商与 Token Plan 专用协议，成功时返回可播放 URL。
- 投放：下载 15 秒分镜 TXT，不生成视频文件。

## 自愈式 Listing CI/CD（已实现）

| 能力 | 实现 | 说明 |
|---|---|---|
| 版本化政策包 | `api/policy/` | 每个快照含 platform / version / effective_date / excerpt_date / source_url / rules / status（current \| candidate \| historical）。内置 Amazon US 当前 + 2025 历史回放基线、TikTok Shop US 当前、Shopify 当前。规则可执行：标题长度、禁用字符、同词重复上限、白底主图（说明性）。 |
| 确定性政策 diff | `api/policy/diff.py` | 比较两份快照，返回新增 / 移除 / 变更（含旧值、新值、受影响字段、出处、生效日）。不调用模型。 |
| 稳定 SKU 事实 ID | `api/skufacts.py` | 品名 = `name`，每条非空卖点行 = `fact-1`、`fact-2`…。生成的每个字段带 `factRefs`（引用的事实 ID），非法引用被安全忽略。 |
| 影响面分析（blast radius） | `api/migration.py::analyze_impact` | 回答：哪些产物受影响 / 不受影响、原因（SKU 事实 / 政策 / 两者）、需重编译的字段、可复用的字段。Amazon-only 政策变更不会标记 TikTok / Shopify；无依赖元数据的旧产物走保守回退并说明原因。 |
| 影子编译（候选补丁） | `api/migration.py::build_candidate_patches` + `POST /api/migration/candidate` | 只针对受影响的平台 / 字段（接口拒绝影响集外的目标）。优先用模型返回的 JSON patch（仅在配置 Token Plan 时），否则走确定性回退（数值 token 替换 / 按词边界截断标题 / 去除禁用字符）。当前已批准产物**不被改写**。 |
| 最小应用 | `POST /api/migration/apply` | 仅写入已批准字段，其余字段逐字节保留；更新版本 / 政策版本；重跑确定性校验；成功重建的产物清除「已过期」；未解决项保持「需人工复核」。 |
| 回滚 | `POST /api/migration/rollback` | 应用前持久化完整本地快照；回滚确定性还原产物值 / 状态 / 政策版本，不调用模型。 |
| 迁移报告 | `POST /api/migration/report`（JSON，`?format=html` 可读版） | 含旧 / 新规则版本、变更规则、出处 URL、受影响 / 未受影响计数、改写字段、保留字段、待人工项、前后校验、applied / rolled_back 状态、时间戳。 |
| 画布工作流 | `web/src/station/MigrationPanel.tsx` | 「规则变更 / 迁移」面板：当前 / 候选政策版本、规则 diff、出处与日期、受影响 / 未受影响计数与原因、点击受影响项聚焦对应画布节点、迁移状态。受影响的结果卡显示「已过期」（琥珀），未受影响的卡不移动、不改状态。Agent 面板不移动画布相机。 |

### P1 已实现

- 候选补丁的文本语义保真度校验（`api/semantic_gate.py`）：从候选文案反向抽取事实、与来源事实比对、阻断无来源的数值新增；
  校验器与生成调用相互独立（生成响应不能给自己打分）；测试用打桩校验器。

## 内置演示场景

1. **真实政策迁移回放**：从 Amazon 2025-01-20 历史基线迁移到 2025-01-21 已生效标题规则 → 仅 Amazon 产物「已过期」→ 展示规则 diff 与受影响字段 →
   构建 Amazon-only 候选补丁 → TikTok / Shopify / 图片 / 无关视频保持不变 → 批准 → 回滚。
2. **SKU 事实漂移**：把容量从 350ml 改为 300ml → 引用容量的产物「已过期」→ 无关素材仍可复用 →
   候选编译只改与容量相关的内容 → 展示保留字段计数。

两个场景在模型不可用时均为确定性，界面明确标注为本地演示数据，非线上店铺数据。

## checker 当前覆盖

1. Amazon 标题上限、禁用字符、同词重复上限与五点数量。
2. TikTok Shop 标题合规（见下）。
3. Shopify 标题与长描述。
4. 非 Shopify 草稿中的 BPA-Free 关键词。
5. promo 模式下的货架图片用途冲突。

checker 不读取图片像素，不验证背景 RGB、图片文字或主体占比。政策包中的「白底主图」类规则标记为说明性，不做机械判定。

### TikTok Shop 标题合规

真实生产接口测试发现：模型会生成社交口播式标题（表情 + 话题标签 + 标题党开头），而旧校验放行。
现按 `api/policy/snapshots/tiktok-us-current.yaml` 逐条机械校验，每条违规在结果卡上单独成行，
带说明、问题片段与建议改法：

| 规则 ID | 级别 | 依据 |
|---|---|---|
| `tiktok.title.min_length` / `max_length` | warn | 原文 “Product titles should be between 25-200 characters”。官方质量分层页另写 25–255，差异已记录，取较保守的 25–200。 |
| `tiktok.title.no_hashtags` | **阻断** | 原文禁用符号表内含 `#`。话题标签移入独立的「社交文案」字段。 |
| `tiktok.title.prohibited_chars` | **阻断** | 原文 “Avoid symbols and special characters (~ ! * $ ? _ { } # < > \| ; ^ ¬ ¦)”。 |
| `tiktok.title.no_promotional_language` | **阻断** | 原文 “Avoid marketing material, promotions, or subjective comments…”。含标题党开头（Stop carrying…、You won't believe…、Must-have、Best ever 等）。 |
| `tiktok.title.no_emoji` | **阻断** | **本工具保守推导**：官方只写 “symbols and special characters”，未逐字点名 emoji；本工具按符号从严拦截。不得对外表述为平台原文。 |
| `tiktok.title.structure` | warn | 依据 “Add important information such as: Brand, Product type, Key features…, Size or quantity”。要求标题以品牌/品类开头，含事实属性与规格。官方为建议措辞，故为 warn。 |

阻断违规的处理：草稿状态置为 `needs_human_review`，结果卡显示阻断闸门与确定性「建议标题」，
**不会被静默沿用、不会自动上架**；迁移 `apply` 也拒绝把带阻断违规的产物标记为 `applied`
（即便本次迁移与标题规则无关）。人工复核与回滚行为保持不变。

`POST /api/listing/validate` 用同一套 `apply_checks` 重新评级外部或人工修改过的草稿，不调用模型。

## 产品边界

- 不自动上架；不做自动化的平台发布。状态用词始终真实：current / stale / candidate / applied / rolled back / needs human review，绝不写「已发布」。
- 不登录卖家店铺或广告账户。
- 不担保审核结果。
- 不在演示时抓取平台页面；政策快照为仓库内的带日期摘录。
- 候选迁移在用户显式批准前，绝不覆盖当前产物；未改动的产物保留其精确取值与 ID。
- 外部模型和图片服务均依赖运行时配置；未配置时使用本地草稿 / 空图片结果，迁移工作流仍可确定性运行。

完整初赛方案见 `PROPOSAL.md`，官方表稿见 `SUBMISSION.md`，部署见 `DEPLOY.md`。
