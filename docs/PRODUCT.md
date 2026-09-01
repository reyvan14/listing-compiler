# 产品口径定稿

产品名称：跨境上架编译器

参赛场景：场景 1「AI 智能上新」

阶段：创意初赛原型

## 一句话

输入一次 SKU 品名、卖点、平台选择和图片，生成 Amazon、TikTok Shop、Shopify 三套字段化草稿及检查结果；运营复核后自行到平台后台提交。

## 当前产品结构

- 前端：Vite + React + tldraw 单页画布。
- 节点：只有 `sku_listing` 与 `listing_result`。
- 后端：FastAPI `POST /api/listing/generate`。
- 文本：upstream → OpenAI 兼容 LLM → `fallback_drafts` 三级降级。
- 规则：`rules.yaml` 保存部分公开规则摘录；`checker.py` 实现确定性规则子集。
- 图片：兼容 `/images/generations`，成功时返回 data URL。
- 投放：下载四段 15 秒分镜 TXT，不生成视频文件。

## checker 当前覆盖

1. Amazon 标题字符数与五点数量。
2. TikTok Shop 标题字符数。
3. Shopify 标题与长描述。
4. 非 Shopify 草稿中的 BPA-Free 关键词。
5. promo 模式下的货架图片用途冲突。

checker 不读取图片像素，不验证背景 RGB、图片文字或主体占比。`rules.yaml` 当前也没有被实现为自动驱动全部检查的通用规则引擎。

## 产品边界

- 不自动上架。
- 不登录卖家店铺或广告账户。
- 不担保审核结果。
- 上传图当前未被后端用于图生图。
- 外部模型和图片服务均依赖运行时配置；未配置时使用本地草稿或空图片结果。

完整初赛方案见 `PROPOSAL.md`，官方表稿见 `SUBMISSION.md`。
