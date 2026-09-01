# 跨境上架编译器

参赛场景：场景 1「AI 智能上新」

参赛团队：拒做韭菜（恩筑AI / NGJOO），队长梁锐文

参赛阶段：创意初赛

实现口径：以当前仓库代码为准

## 一、方案概述

跨境运营把同一个 SKU 放到 Amazon、TikTok Shop 和 Shopify 时，面对的并不是三次复制粘贴：Amazon 需要标题、五点和搜索词，TikTok Shop 需要自己的标题与描述，Shopify 更适合品牌标题和长描述；货架主图与品牌站生活图也有不同用法。规则散落在各平台公开资料中，运营容易在“写文案、改图片、逐项自查”之间反复切换。

跨境上架编译器把这件事定义成一次上架前编译：输入品名、卖点、目标平台和图片，输出三台字段化草稿、配图位和检查结果。它像编译器一样保留同一份 SKU 源信息，再按平台目标生成不同结构，并把当前能识别的问题标成“能贴 / 需改 / 只能去投放”。最终提交仍由运营在各平台后台完成，产品**不自动上架**。

初赛原型已经能演示从 `sku_listing` 输入节点生成 Amazon、TikTok Shop、Shopify 三个 `listing_result` 结果节点，并展示标题、部分字段、图片和检查项。原型也能演示带字竖版与货架主图的冲突，以及生成一份 15 秒投放脚本。投放下载物当前是 `.txt` 脚本，不是视频文件。

## 二、目标用户与价值

目标用户是同时维护多个跨境渠道的品牌运营或小团队。产品希望把以下工作放到一个可追踪的画布中：

1. 同一 SKU 的事实只输入一次，减少三套文案反复改写。
2. 输出按平台字段组织，不把一篇通用长文硬拆成三份。
3. 在提交前暴露标题长度、五点数量、敏感宣称和素材用途冲突。
4. 把“货架草稿”和“投放脚本”分开，避免把广告素材误当商品主图。

这是创意初赛原型，价值主张是缩短上新准备与人工核对路径，不承诺平台审核结果，也没有接入店铺发布接口。

## 三、产品流程

1. 运营在 tldraw 画布的 `sku_listing` 节点中填写品名和卖点，可上传最多 3 张图片，并勾选目标平台。
2. 前端调用 FastAPI 的 `POST /api/listing/generate`。
3. 后端文本生成采用**三级降级**：可选 upstream chat → 配置后的 OpenAI 兼容 LLM → 本地 `fallback_drafts`。
4. 文本与图片任务并行执行。图片支路调用 OpenAI 兼容 `/images/generations`；成功时把图片转成 data URL 回传，未配置或失败时不阻断文本结果。
5. `checker.py` 对返回草稿做确定性检查；前端把每个平台结果渲染为 `listing_result` 节点。
6. 运营复制标题或回到平台后台人工提交。点击投放功能时，当前版本下载一份 15 秒分镜 TXT。

## 四、核心功能与真实完成度

| 功能 | 当前代码已经实现 | 当前边界 |
|---|---|---|
| 三台草稿 | Amazon、TikTok Shop、Shopify 的结构化标题与字段；可只选部分平台 | 首期固定三台 |
| 生成编排 | FastAPI 接口；文本三级降级；文本与图片并行 | 外部模型均依赖运行时配置 |
| 规则资料 | `rules.yaml` 保存三台的部分公开规则、来源链接和摘录日期；接口可读取 | 当前 `checker` 不是通用 YAML 解释器，部分阈值仍写在代码中 |
| 生成后检查 | 标题字符数、Amazon 五点数量、Shopify 标题与长描述、BPA 关键词、promo 模式素材冲突 | 不检查图片像素、背景色或主体占比；不替平台终审 |
| 图片 | 兼容 `/images/generations` 生成白底图和生活图，结果以 data URL 回传 | 不是平台素材库；当前 `uploads` 未用于图生图 |
| 画布 | Vite + React + tldraw；仅注册 `sku_listing` / `listing_result` 两类业务节点 | 是单页原型，不含店铺管理后台 |
| 投放条 | 展示 15 秒、9:16 的四段脚本并下载 `.txt` | 没有渲染视频文件，也不连接广告账户 |

## 五、为什么叫“上架编译器”

这个口径不是把原型包装成自动发布系统，而是描述它当前最清楚的产品结构：

- 源输入：SKU 名称、卖点、平台选择、素材模式。
- 目标平台：Amazon、TikTok Shop、Shopify。
- 编译产物：各台字段化草稿、图片引用和检查项。
- 诊断信息：长度、字段数量、关键词与素材用途冲突。
- 人工交付：运营复制或下载后，在平台后台自行完成上新。

与通用文案生成器相比，差异在于同一输入有多个明确的目标结构，并在生成后执行机械检查。与自动化发布工具相比，边界是它只做到上架前准备。

## 六、技术方案

### 前端

- Vite + React 19 + TypeScript。
- tldraw 作为节点画布与连接关系的运行时。
- `NodeDefinitions` 只包含 `sku_listing` 和 `listing_result`。
- `listingApi.ts` 按 `/api/listing/generate`、反向代理路径、本机 8788 端口依次尝试；接口不可用时再使用前端本地草稿，保障演示可继续。

### 后端

- FastAPI 提供 `POST /api/listing/generate`，另保留 `/api/generate` 别名，并提供 `/api/rules`。
- `generate.py` 用 `asyncio.gather` 并行执行文本与图片任务。
- 文本三级降级顺序固定为 upstream、OpenAI 兼容 chat completions、本地 `fallback_drafts`；响应中的 `source` 会标明实际来源。
- `images.py` 调用兼容 `/images/generations` 的服务；支持 `b64_json` 或临时 URL，并统一转为 data URL。
- `checker.py` 覆盖确定性规则子集并覆盖模型自报的检查状态，避免让模型自行宣称检查通过。

### 规则与检查

`rules.yaml` 当前记录 Amazon、TikTok Shop、Shopify 的平台角色、图片提示、来源 URL 和摘录日期。`checker.py` 当前实现的检查包括：

- Amazon 标题 1–200 字符、五点数量至少 5 条。
- TikTok Shop 标题 25–200 字符。
- Shopify 标题非空、长描述不少于 40 字符。
- 非 Shopify 草稿中的 BPA-Free 关键词提示。
- `asset_mode=promo` 时，Amazon 与 TikTok Shop 图片用途标为需改，Shopify 可继续作为品牌站素材。

图片“通过”只代表系统按所选素材模式给出用途判断。当前 checker 没有读取图片像素，不会验证真实背景 RGB、文字覆盖或主体比例。

## 七、可靠性与边界

- 未配置模型时仍可用 `fallback_drafts` 展示完整流程。
- 图片生成失败不会阻断文本草稿。
- API 整体不可达时，前端还有本地草稿作为演示兜底。
- 不自动上架，不登录卖家店铺，不操作广告账户。
- 规则资料是带日期的摘录，不能替代平台最新政策或人工复核。
- 输出是草稿和诊断，不担保审核结果。

## 八、初赛演示建议

使用折叠硅胶水杯 350ml 作为单一演示 SKU：填入信息 → 生成三台节点 → 展示 Amazon 五点与 TikTok Shop 标题检查 → 指出 BPA-Free 需人工补证 → 切换带字竖版并看到两台货架素材打红 → 下载投放 TXT。全程只讲已经能从代码或界面验证的能力。

## 九、代码证据索引

- 接口与请求体：`api/app.py`
- 三级降级与并行编排：`api/generate.py`
- 机械检查：`api/checker.py`
- 规则摘录：`api/rules.yaml`
- 本地草稿：`api/drafts.py`
- 图片 data URL：`api/images.py`
- 前端调用与本地兜底：`web/src/station/listingApi.ts`
- tldraw 工位：`web/src/station/StationApp.tsx`
- 两类节点注册：`web/src/pipeline/nodes/nodeTypes.tsx`
- 投放 TXT 下载：`web/src/pipeline/nodes/types/skuStation.ts`
