# 跨境上架编译器

**面向商品与平台双重漂移的自愈式 Listing CI/CD。**

跨境 SKU 上架前编译器：把一份 SKU 信息生成 Amazon、TikTok Shop、Shopify 三套字段化草稿与检查结果；
当 SKU 事实或平台政策变化时，计算精确影响面、把受影响产物标记为「已过期」、在不覆盖已批准内容的前提下
构建候选补丁，并支持逐项批准与回滚。

## 代码事实

- `web/`：Vite + React + tldraw，注册 `sku_listing` / `listing_result` / `image_generation` / `video_generation` 节点。
- `api/`：FastAPI，核心接口为 `POST /api/listing/generate`。
- 文本：upstream → Token Plan（OpenAI 兼容 chat）→ `fallback_drafts` 三级降级。
- 图片 / 视频：兼容旧供应商与 Token Plan 专用协议，成功结果以可播放 URL 返回。
- 检查：`checker.py` 只检查字段内容与素材模式，不读取图片像素。
- 规则：`api/policy/snapshots/*.yaml` 版本化、可执行的政策包；`GET /api/rules` 由「当前」快照拼装，保持向后兼容。
- 投放：下载 15 秒分镜 TXT，不生成视频文件。
- 边界：不自动上架、不做自动化平台发布，不担保审核结果。状态用词始终真实（current / stale / candidate /
  applied / rolled back / needs human review），绝不写「已发布」。

## 自愈式 Listing CI/CD

当 SKU 事实（品名 / 卖点）或平台政策变化时：

| 步骤 | 接口 | 说明 |
|---|---|---|
| 政策快照 | `GET /api/policy/snapshots` | 版本化政策包（current / candidate），含出处 URL、生效日、摘录日。 |
| 政策 diff | `GET /api/policy/diff?base=&candidate=` | 确定性比较，返回新增 / 移除 / 变更（旧值 → 新值）。不调用模型。 |
| 影响面分析 | `POST /api/migration/impact` | 哪些产物受影响 / 不受影响、原因（SKU 事实 / 政策 / 两者）、需重编译 / 可复用的字段。 |
| 影子编译 | `POST /api/migration/candidate` | 只针对受影响的平台 / 字段，请求模型返回 **JSON patch**（未配置模型时走确定性回退）。当前产物不被改写。 |
| 最小应用 | `POST /api/migration/apply` | 仅写入已批准字段，其余逐字节保留；重跑校验；未解决项保持「需人工复核」。 |
| 回滚 | `POST /api/migration/rollback` | 确定性还原，不调用模型。 |
| 迁移报告 | `POST /api/migration/report`（`?format=html` 可读版） | 旧 / 新规则版本、变更规则、出处、受影响 / 未受影响计数、改写 / 保留字段、待人工项、前后校验、状态、时间戳。 |

画布上的「规则变更 / 迁移」面板串起这套流程，并内置两个确定性本地演示场景（平台政策漂移 / SKU 事实漂移）。
详见 `docs/PRODUCT.md`。

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

## 测试

```bash
# 后端（pytest）
cd api && pip install -r requirements-dev.txt && pytest

# 前端单测（Vitest）+ 类型检查 + 生产构建
cd web && yarn && yarn test && yarn typecheck && yarn build

# 浏览器 E2E（Playwright，跑在 FastAPI 服务的 web/dist 上，1440 与 1280 两个视口）
cd web && yarn build && yarn test:e2e
```

自动化测试从不调用真实模型 Provider：迁移接口的 `use_model` 在未配置 Token Plan 时直接走确定性回退。

部署步骤见 `docs/DEPLOY.md`。初赛提交材料见 `docs/SUBMISSION.md`、`docs/PROPOSAL.md` 和 `docs/README-SUBMIT.md`。
