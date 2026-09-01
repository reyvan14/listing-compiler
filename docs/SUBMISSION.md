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

跨境上架编译器做上架前编译：运营输入一次品名、卖点、目标平台和图片，系统输出三台字段化草稿及检查结果。当前原型以 Vite + React + tldraw 展示节点工作流，业务节点只有 `sku_listing` 和 `listing_result`。输出供运营查看、复制标题和复核，最终仍由运营在平台后台提交，**不自动上架**。

### 目标用户与业务痛点

- 目标用户：同时维护多个跨境渠道的品牌运营或小团队。
- 痛点一：同一份产品事实要被重写成三种字段结构。
- 痛点二：货架素材、品牌站素材和投放素材容易混用。
- 痛点三：生成结果缺少提交前的确定性检查，问题常在最后一步才暴露。

### 核心功能

1. 单 SKU 输入：填写品名和卖点、上传图片、勾选目标平台。
2. 三台编译：生成 Amazon、TikTok Shop、Shopify 的结构化草稿。
3. 生成后检查：`checker.py` 检查标题字符数、Amazon 五点数量、Shopify 长描述、BPA 关键词和 promo 素材用途冲突。
4. 规则可见：`rules.yaml` 保存部分公开规则的来源 URL 与摘录日期，`/api/rules` 可读取；界面另显示对应的静态规则表。
5. 投放脚本：给出 15 秒、9:16 的四段分镜并下载 TXT；当前不是视频成片。

### 方案亮点及预期效果

- 编译器口径：一份 SKU 源信息面向三个目标平台生成不同结构，而不是输出一篇通用文案。
- 检查与生成分离：模型负责草稿，checker 负责当前已实现的机械规则子集，并覆盖模型自报状态。
- 可解释降级：文本采用 upstream → OpenAI 兼容 LLM → `fallback_drafts` 的**三级降级**，响应标明实际来源。
- 可验证演示：单个演示 SKU 可在 tldraw 画布生成三台节点、查看检查结果、演示带字竖版冲突并下载投放 TXT。
- 边界明确：初赛展示创意与可运行原型；不自动上架，不担保审核结果。
- 团队：参赛队「拒做韭菜」，所属恩筑AI（NGJOO），队长梁锐文。完整竞赛荣誉见 `submit/团队信息.txt` 与 https://www.ngjoo.com/ 。

## 4. 技术方案

### 拟使用的模型或能力

- 文本：后端支持可选 upstream chat 和配置后的 OpenAI 兼容 chat completions；均不可用时返回本地 `fallback_drafts`。
- 图片：通过 OpenAI 兼容 `/images/generations` 请求白底图与生活图，成功结果转为 data URL。当前代码没有接赛事指定平台服务。
- 规则：`rules.yaml` 作为可查看的规则摘录；`checker.py` 实现其中一部分确定性检查。

### 工作流

`SKU 输入 → POST /api/listing/generate → 文本三级降级与图片任务并行 → checker → 三个 listing_result 节点 → 人工查看/复制标题 → 运营自行提交`

接口由 FastAPI 提供；`generate.py` 使用 `asyncio.gather` 同时启动文本和图片任务。图片任务失败不阻断文本。接口不可达时，前端 `listingApi.ts` 还会返回本地草稿，保证初赛演示可继续。

### 数据处理方式

- 输入：品名、卖点、平台选择、素材模式、最多 3 张前端图片。
- 输出：平台草稿、检查项、实际文本来源和可选图片 data URL。
- 当前限制：`images.py` 尚未把上传图用于图生图；checker 不读取像素，只根据字段内容与 `asset_mode` 判断；图片不会上传到平台素材库。
- 安全边界：示例配置文件仅列变量名，提交材料不包含 Key。

### 前后端组件

- 前端：Vite、React 19、TypeScript、tldraw、TanStack Query。
- 后端：FastAPI、Pydantic、httpx、PyYAML。
- 节点：仅 `sku_listing` / `listing_result`。
- 接口：`POST /api/listing/generate`、`GET /api/rules`、`GET /health`。

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
