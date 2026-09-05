# 天池创意初赛提交稿（官方表结构）

## 1. 基本信息

| 官方字段 | 填写内容 |
|---|---|
| 团队名称 | 拒做韭菜（恩筑AI / NGJOO） |
| 队长信息 | 梁锐文 |
| 参赛场景 | 场景 1：AI 智能上新 |

## 2. 方案名称

跨境上架编译器

## 3. 方案概述

### 解决的问题

同一 SKU 铺到 Amazon、TikTok Shop、Shopify 时，各台字段与素材用途不同：Amazon 需要标题、五点与搜索词，TikTok Shop 需要自己的标题和描述，Shopify 更适合品牌标题与长描述；货架主图和品牌站生活图也不能简单混用。运营需要反复改写、查规则和人工核对。

跨境上架编译器做上架前编译：运营输入一次品名、卖点、目标平台和图片，系统输出三台字段化草稿及检查结果，草稿进入可编辑的修订与审批流程，图片按真实像素做合规检查，通过后导出一份可复现、可校验的交接包。当前原型以 Vite + React + tldraw 展示节点工作流，业务节点为 `sku_listing`、`listing_result`、`image_generation`、`video_generation`。最终仍由运营在平台后台提交，**不自动上架**。

### 目标用户与业务痛点

- 目标用户：同时维护多个跨境渠道的品牌运营或小团队。
- 痛点一：同一份产品事实要被重写成三种字段结构。
- 痛点二：货架素材、品牌站素材和投放素材容易混用。
- 痛点三：生成结果缺少提交前的确定性检查，问题常在最后一步才暴露。

### 核心功能

1. 单 SKU 输入：填写品名和卖点、上传图片、勾选目标平台。
2. 三台编译：生成 Amazon、TikTok Shop、Shopify 的结构化草稿。
3. 生成后检查：`checker.py` 检查标题字符数、Amazon 五点数量、Shopify 长描述、BPA 关键词和 promo 素材用途冲突。
4. 规则可见：`api/policy/snapshots/*.yaml` 为版本化、可执行的政策包，保存来源 URL、摘录日期与生效日；`/api/rules` 由「当前」快照拼装。
5. 投放脚本：给出 15 秒、9:16 的四段分镜并下载 TXT；当前不是视频成片。
6. 修订与审批：草稿 → 校验 → 批准 → 取代 / 回滚。已进入审核的修订被编辑时派生新候选而非被覆盖；批准前重跑确定性校验，有阻断项即拒绝；同一 SKU + 平台只有一条生效修订。
7. 图片合规：解码真实像素后判定格式、尺寸、比例、透明通道与纯白背景；主体占比与叠加文字需 OCR / 检测，本工具未启用，一律标为「需人工核验」，不静默通过。
8. 发布护照与交接包：由存储实体 ID 组装，导出确定性 ZIP（manifest 列出每个文件的路径、字节数、SHA-256 与来源实体），生成后重新校验；导出需显式二次确认，且不向任何平台发布。
9. 项目存档：画布自动保存到浏览器本地，可导出 / 导入；刷新后精确恢复原图，不会重新生成节点或伪造修订历史。

### 方案亮点及预期效果

- 编译器口径：一份 SKU 源信息面向三个目标平台生成不同结构，而不是输出一篇通用文案。
- 检查与生成分离：模型负责草稿，checker 负责当前已实现的机械规则子集，并覆盖模型自报状态。
- 可解释降级：文本采用 upstream → OpenAI 兼容 LLM → `fallback_drafts` 的**三级降级**，响应标明实际来源。
- 可验证演示：单个演示 SKU 可在 tldraw 画布生成三台节点、查看检查结果、演示带字竖版冲突并下载投放 TXT。
- 证据先于结论：图片结论只来自解码后的像素，提示词与文件名不构成证据；判不了的项目返回「需人工核验」而不是通过。
- 交接可复现：同一份已存储护照导出两次字节一致；包内每个文件都可按 manifest 逐条重算 SHA-256 校验。
- 边界明确：初赛展示创意与可运行原型；不自动上架，不担保审核结果，导出交接包不等于发布。
- 团队：参赛队「拒做韭菜」，所属恩筑AI（NGJOO），队长梁锐文。完整竞赛荣誉见 `submit/团队信息.txt` 与 https://www.ngjoo.com/ 。

## 4. 技术方案

### 拟使用的模型或能力

- 文本：后端支持可选 upstream chat 和配置后的 OpenAI 兼容 chat completions；均不可用时返回本地 `fallback_drafts`。
- 图片：通过 OpenAI 兼容 `/images/generations` 请求白底图与生活图，成功结果转为 data URL。当前代码没有接赛事指定平台服务。
- 规则：版本化政策快照作为可查看的带日期摘录；`checker.py` 与 `imagecheck.py` 实现其中的确定性检查（前者判文本，后者判像素，互不顶替）。
- 图片检查：Pillow 本地解码，不调用任何外部服务。

### 工作流

`SKU 输入 → POST /api/listing/generate → 文本三级降级与图片任务并行 → checker → 三个 listing_result 节点 →
可编辑修订 → 确定性校验 → 人工批准 → 发布护照（就绪状态由记录算出）→ 导出交接包 → 运营自行提交`

接口由 FastAPI 提供；`generate.py` 使用 `asyncio.gather` 同时启动文本和图片任务。图片任务失败不阻断文本。接口不可达时，前端 `listingApi.ts` 还会返回本地草稿，保证初赛演示可继续。

### 数据处理方式

- 输入：品名、卖点、平台选择、素材模式、最多 3 张前端图片。
- 输出：平台草稿、检查项、实际文本来源和可选图片 data URL。
- 持久化：证据文档、产品事实、修订与审批、图片资产与检查结果、发布护照均按「浏览器工作区 + 商品」作用域落盘为 JSON 账本 + 内容寻址 blob，不入数据库；画布另存一份浏览器本地快照。
- 当前限制：`images.py` 尚未把上传图用于图生图；文本 checker 不读取像素（像素由 `imagecheck.py` 单独判定）；图片不会上传到平台素材库；主体占比与叠加文字未做自动判定。
- 安全边界：示例配置文件仅列变量名，提交材料不包含 Key。交接包与项目文件在导出前都会扫描凭证字段，发现即中止 / 拒绝。

### 前后端组件

- 前端：Vite、React 19、TypeScript、tldraw、TanStack Query。
- 后端：FastAPI、Pydantic、httpx、PyYAML。
- 图片：Pillow（本地解码与像素采样）。
- 节点：`sku_listing` / `listing_result` / `image_generation` / `video_generation`。
- 接口：`POST /api/listing/generate`、`GET /api/rules`、`GET /health`；证据 `/api/evidence/*`；审核 `/api/review/*`；图片检查 `/api/media/assets/*`；发布护照 `/api/passport/*`；迁移 `/api/migration/*`、`/api/portfolio/*`；Agent `/api/agent/chat` 与 `/api/agent/chat/stream`。

## 5. 附加材料

- 可测 Demo（优先填这个）：https://returned-instructors-abc-winston.trycloudflare.com
- 团队荣誉墙：https://www.ngjoo.com/
- 流程图：`docs/flow.png`
- 技术架构图：`docs/architecture.png`
- 截图说明：`docs/ATTACHMENTS.md`
- 截图目录：`docs/attachments/`
- 完整方案：`docs/PROPOSAL.md`

## 6. 提交前自检（不粘贴进官方表）

- 团队名称填「拒做韭菜」，队长填梁锐文，公司写恩筑AI / NGJOO。
- 初赛场景只选场景 1。
- 投放下载物按 TXT 脚本描述。
- 图片检查按字段/模式检查描述，不写像素识别。
- 保留“不自动上架”和“不担保审核结果”的边界。
