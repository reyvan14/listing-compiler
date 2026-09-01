# 附件索引与使用说明

建议提交顺序如下。前三张均来自主仓 `web/scripts/verify-*.png`，优先证明当前 tldraw 节点原型；第四张仅补充冲突态，不作为首页主视觉。

| 序号 | 文件 | 来源 | 能证明什么 | 不能证明什么 |
|---|---|---|---|---|
| 01 | `attachments/01-sku-input.png` | `web/scripts/verify-images.png` | tldraw 画布、`sku_listing` 节点、品名/卖点/三平台选择、两张输入素材 | 不证明上传图参与了图生图 |
| 02 | `attachments/02-three-results.png` | `web/scripts/verify-result.png` | 一个输入节点生成三个 `listing_result` 节点；显示平台字段和 checker 状态 | 截图中的图片区域未完整加载；不证明像素检查或平台提交 |
| 03 | `attachments/03-source-variation.png` | `web/scripts/verify-parallel.png` | 外部文本结果可按同一节点结构渲染，三台连接关系保持一致 | 长文布局仍是原型状态；不代表所有字段已经过人工校对 |
| 04 | `attachments/04-promo-conflict.png` | 文档仓 `screenshots/04-conflict.png` | 带字竖版模式下 Amazon、TikTok Shop 的货架图片用途被标红，Shopify 保留可用状态 | 这是模式规则演示，checker 没有读取图片像素 |

## 推荐上传组合

如附件数量有限，优先上传 01、02、04，再附 `flow.png` 与 `architecture.png`。01 是最清楚的当前工位视图；02 证明节点生成结果；04 说明产品为何不只是通用文案生成器。

## 可测 Demo

在线原型：https://returned-instructors-abc-winston.trycloudflare.com

当前已确认：首页可打开，`GET /health` 返回 `{"ok":true}`，`GET /api/rules` 可返回三台规则。评委可直接在画布里点「生成三台草稿」。隧道进程关掉后地址会失效，初赛提交前请保持进程在线，并同时上传截图作备份。

## 统一说明文字

截图展示的是初赛可运行原型。前端使用 Vite + React + tldraw，业务节点只有 `sku_listing` 与 `listing_result`。后端通过 `POST /api/listing/generate` 返回草稿，文本采用三级降级，`checker.py` 做字段与模式检查。原型不自动上架；投放功能实际下载 TXT 脚本。

## 截图使用注意

- 不把结果图中的“能贴”解释为平台审核结论。
- 不声称图片通过像素、背景色或文字识别。
- 不把 15 秒投放脚本描述成视频文件。
- 不把补充截图包装成另一套产品界面。
