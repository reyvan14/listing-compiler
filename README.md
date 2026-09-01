# 跨境上架编译器

跨境 SKU 上架前编译器原型：把一份 SKU 信息生成 Amazon、TikTok Shop、Shopify 三套字段化草稿与检查结果。

## 代码事实

- `web/`：Vite + React + tldraw，只注册 `sku_listing` / `listing_result` 两类业务节点。
- `api/`：FastAPI，核心接口为 `POST /api/listing/generate`。
- 文本：upstream → OpenAI 兼容 LLM → `fallback_drafts` 三级降级。
- 图片：兼容 `/images/generations`，成功结果以 data URL 返回。
- 检查：`checker.py` 只检查字段内容与素材模式，不读取图片像素。
- 投放：下载 15 秒分镜 TXT，不生成视频文件。
- 边界：不自动上架，不担保审核结果。

## 启动

```bash
# 后端 :8788
cd api && pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8788

# 前端 :8091
cd web && yarn && yarn dev
```

打开 <http://localhost:8091>。可选模型配置见 `api/.env.example`，不要把 Key 写入仓库。

初赛提交材料见 `docs/SUBMISSION.md`、`docs/PROPOSAL.md` 和 `docs/README-SUBMIT.md`。
