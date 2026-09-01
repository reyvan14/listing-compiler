# 跨境上架编译器

跨境 SKU 上架前编译器原型：把一份 SKU 信息生成 Amazon、TikTok Shop、Shopify 三套字段化草稿与检查结果。

## 代码事实

- `web/`：Vite + React + tldraw，只注册 `sku_listing` / `listing_result` 两类业务节点。
- `api/`：FastAPI，核心接口为 `POST /api/listing/generate`。
- 文本：upstream → Token Plan（OpenAI 兼容 chat）→ `fallback_drafts` 三级降级。
- 图片：兼容 `/images/generations`，成功结果以 data URL 返回。
- 检查：`checker.py` 只检查字段内容与素材模式，不读取图片像素。
- 投放：下载 15 秒分镜 TXT，不生成视频文件。
- 媒体节点：SKU 生成成功后落一份下游素材包（视频 brief + 去重图片）；接到「视频生成」节点时，
  brief 进提示词、首张可用图片作首帧（走 `happyhorse-1.1-i2v`）。
- 边界：不自动上架，不担保审核结果。

## 启动

```bash
# 后端 :8788
cd api && pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8788

# 前端 :8091
cd web && yarn && yarn dev
```

打开 <http://localhost:8091>。模型配置见 `api/.env.example`，不要把 Key 写入仓库。

### Token Plan（指定模型）

后端文本生成与工位 Agent 走阿里云百炼 **Token Plan** 专属 OpenAI 兼容接口。通过环境变量启用（复制 `api/.env.example` 到 `api/.env` 填写）：

| 变量 | 说明 | 默认 |
|---|---|---|
| `TOKEN_PLAN_API_KEY` | 专属 Key，**必填**，勿写入仓库 | — |
| `TOKEN_PLAN_BASE_URL` | 专属 base URL（勿用通用 dashscope 域名） | `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` |
| `TOKEN_PLAN_TEXT_MODEL` | 生成三台草稿用的模型 | `qwen3.7-plus` |
| `TOKEN_PLAN_AGENT_MODEL` | 工位 Agent 用的模型 | `qwen3.7-plus` |
| `TOKEN_PLAN_TIMEOUT_S` / `TOKEN_PLAN_CONNECT_TIMEOUT_S` | 读 / 连接超时（秒） | `60` / `10` |

未配置 Key 时自动回退到本地 `fallback_drafts`，演示仍可运行。图片 / 视频 Provider 也支持 Token Plan 专用协议（见 `docs/DEPLOY.md`），未配置时保持旧供应商链路。

连通性自检（不打印 Key）：`cd api && python scripts/check_token_plan.py`

后端测试：`cd api && pip install -r requirements-dev.txt && pytest`

部署步骤见 `docs/DEPLOY.md`。初赛提交材料见 `docs/SUBMISSION.md`、`docs/PROPOSAL.md` 和 `docs/README-SUBMIT.md`。
