# 产品口径定稿

产品名称：跨境上架编译器

定位：**跨境上架编译器——面向商品与平台双重漂移的自愈式 Listing CI/CD**

参赛场景：场景 1「AI 智能上新」

阶段：创意初赛原型

## 一句话

输入一次 SKU 品名、卖点、平台选择和图片，生成 Amazon、TikTok Shop、Shopify 三套字段化草稿及检查结果；
草稿进入**可编辑的修订与审批流程**（草稿 → 校验 → 批准 → 取代 / 回滚），图片按**真实像素**做合规检查，
通过后可导出一份**可复现、可校验的交接包**（发布护照）。当 SKU 事实或平台政策发生变化时，系统计算精确影响面、
把受影响产物标记为「已过期」、在不覆盖已批准内容的前提下构建候选补丁，并支持逐项批准与回滚。
运营复核后自行到平台后台提交——本工具全程不发布。

## 当前产品结构

- 前端：Vite + React + tldraw 单页画布。
- 节点：`sku_listing`、`listing_result`、`image_generation`、`video_generation`。
- 后端：FastAPI。核心接口 `POST /api/listing/generate`；迁移工作流见下。
- 文本：upstream → Token Plan（OpenAI 兼容 chat）→ `fallback_drafts` 三级降级。
- 规则：`api/policy/snapshots/*.yaml` 版本化、可执行的政策包；`/api/rules` 由「当前」快照拼装，保持向后兼容。
- 图片 / 视频：兼容旧供应商与 Token Plan 专用协议，成功时返回可播放 URL。
- 投放：下载 15 秒分镜 TXT，不生成视频文件。
- 审核：`api/review.py` 修订账本（草稿 → 校验 → 批准 → 取代 / 回滚），与证据账本同作用域落盘。
- 图片检查：`api/imagecheck.py` 用 Pillow 解码真实像素，规则来自同一套版本化政策快照。
- 交接：`api/passport.py` 发布护照与确定性 ZIP 交接包。
- 存档：画布按版本化 schema 自动保存在浏览器本地，可导出 / 导入为文件。

## 上新审核 → 图片检查 → 发布护照（已实现）

| 能力 | 实现 | 说明 |
|---|---|---|
| 可编辑修订与审批 | `api/review.py` + 检查器「审核」标签页 | 统一生命周期 draft / in_review / needs_changes / validated / approved / superseded / rolled_back。草稿可原地编辑；已进入审核流程的修订**派生新候选**而不是被覆盖。编辑会作废按旧文案算出的校验结论；批准时**重新运行**确定性校验（与生成同一套 `checker.apply_checks`），仍有阻断项则直接拒绝。同一 SKU + 平台同时只有一条 approved。 |
| 警告豁免 | `POST /api/review/revisions/{id}/acknowledge` | 必须填复核人、理由与具体警告 ID；本次校验没报过的警告无法确认，阻断项不能当警告放行。 |
| 回滚 | `POST /api/review/revisions/{id}/rollback` | 以**新修订**还原选定版本的内容，不删除后续历史；回滚同样过校验闸门，目标在当前规则下不合规则拒绝执行。 |
| 字段级差异 | `GET /api/review/diff` | 任意两条修订按字段比对：未变 / 新增 / 删除 / 修改。未保存的编辑在前端本地比对后再落盘。 |
| 真实像素图片检查 | `api/imagecheck.py` + `api/mediaassets.py` | 解码字节后记录 SHA-256、格式（取自字节而非扩展名）、宽高、精确比例、字节数、色彩模式、alpha、方法版本。背景沿四边固定网格采样 96 点取中位数，一致度 = 与估计色相符的采样点占比。空 / 截断 / 损坏 / 超限 / 不支持 / 声明类型不符一律拒绝，且不入账本。 |
| 判不了就说判不了 | 结果状态 pass / fail / warning / manual_review / unavailable | 主体占比、叠加文字与 logo 需目标检测与 OCR，本工具未启用，一律 `manual_review`，永不静默通过；界面最好的说法只是「可机械判定的项均通过」。 |
| 发布护照 | `api/passport.py` | 全部由存储实体 ID 组装：修订 ID 与内容指纹、逐字段哈希、图片资产哈希、事实与证据哈希、政策快照版本与规则哈希、校验与审批记录。就绪状态 blocked / needs_review / ready_for_handoff / exported / superseded 由真实记录算出，构建时**重跑校验**。 |
| 交接包 | `POST /api/passport/{id}/export` | 确定性 ZIP：条目排序与时间戳固定、不写入导出时刻，同一份已存储护照导出两次字节一致。manifest 列出每个文件的相对路径、字节数、SHA-256 与来源实体；生成后重新打开逐条重算哈希，校验通过才记为「已导出」。需显式二次确认（无 `confirm` 返回 428）。 |
| 项目存档 | `web/src/station/project/` | 画布按版本化 schema 自动保存到浏览器本地；写入分暂存 / 备份 / 换入三步，当前存档损坏时回落备份，两份都读不出则停止自动保存。导入前校验 schema、体积、版本、引用与凭证字段并预览影响，确认后**整体替换**（不支持合并）。 |

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
5. 图片：格式、最小 / 最大尺寸、字节上限、宽高比、透明通道、纯白背景（按像素采样）。
   文本引擎不判定任何 `image_*` 规则，图片检查器不判定任何文本规则，两者结论互不顶替。
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
- **导出交接包是交接，不是发布。** 包内 README 与界面都写明：本工具没有向任何平台提交，通过检查不代表平台会通过审核，
  标记为「需人工核验」的项目未被任何自动检查判定，由操作者负责。
- 图片结论只来自解码后的像素。提示词写了「纯白背景」、文件名叫 `white.png`、生成模式选了 compliant——都不构成证据。
- 市场、语言、币种与单位制在护照中标注为「由操作者声明、未经核验」；不从产品数据推断价格、币种或计量事实。
- 项目存档明确标注为浏览器本地，不上传服务器，且不存任何密钥；项目文件中出现疑似凭证字段会整体拒绝导入。
- 不登录卖家店铺或广告账户。
- 不担保审核结果。
- 不在演示时抓取平台页面；政策快照为仓库内的带日期摘录。
- 候选迁移在用户显式批准前，绝不覆盖当前产物；未改动的产物保留其精确取值与 ID。
- 外部模型和图片服务均依赖运行时配置；未配置时使用本地草稿 / 空图片结果，迁移工作流仍可确定性运行。

## 尚未实现（不要在演示里声称）

以下能力**没有**实现，文档与界面都不应暗示它们存在：

- 平台发布 / 上架 / 素材库上传：全程没有任何写入平台的调用。
- 主体占比、叠加文字、logo、商品身份与文化适配的自动判定：需目标检测与 OCR，未启用。
- OCR：图片类证据只读像素尺寸，摘录为空并标注 `manual_review`。
- 价格、库存、运费、退货、认证与法律信息：不生成、不推断。
- 多项目合并：导入是整体替换，界面明确说明不支持合并。

完整初赛方案见 `PROPOSAL.md`，官方表稿见 `SUBMISSION.md`，部署见 `DEPLOY.md`。
