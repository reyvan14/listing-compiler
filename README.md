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
- 检查：`checker.py` 只检查字段内容与素材模式，不读取图片像素。TikTok Shop 标题另有一组
  机械合规规则（禁表情、禁话题标签、禁营销/标题党用语、禁特殊字符、结构建议），违规逐条给出
  说明、问题片段与建议改法；命中阻断项的草稿置为「需人工复核」，不会被静默沿用。
  `POST /api/listing/validate` 可用同一套规则重新评级外部或人工修改过的草稿。
- 规则：`api/policy/snapshots/*.yaml` 版本化、可执行的政策包；`GET /api/rules` 由「当前」快照拼装，保持向后兼容。
- 投放：下载 15 秒分镜 TXT，不生成视频文件。
- 边界：不自动上架、不做自动化平台发布，不担保审核结果。状态用词始终真实（current / stale / candidate /
  applied / rolled back / needs human review），绝不写「已发布」。

## 证据账本与发布闸门（Phase 1）

每一条商业宣称都要能追溯到证据。上传规格表、说明书、证书或包装图后，系统会：

1. 以 SHA-256 内容寻址落盘（`api/evidence_store/`，运行时状态，不入库不入仓）；
   记录原始文件名、MIME、大小、上传时间、页码/工作表、摘录片段、有效期与**提取方式**。
2. 确定性地抽取原子事实（容量、折叠尺寸、材质、耐温区间、BPA-Free 等），
   每条事实有稳定 ID 并链接到具体的文档位置。
3. 在发布闸门中比对：文案里的每条宣称是否有已核实的证据支撑。

公开演示按浏览器工作区和当前商品隔离账本，避免不同访客或不同商品串用证据；
该机制用于演示数据隔离，不替代正式账号鉴权。商品名称改变后会进入新的证据作用域。

| 接口 | 说明 |
|---|---|
| `POST /api/evidence/upload` | 上传证据文件（PDF / JPG / PNG / TXT / MD / CSV / XLSX，≤ 20 MB） |
| `GET /api/evidence/sources` · `DELETE /api/evidence/sources/{id}` | 证据文件清单与移除 |
| `GET /api/evidence/facts` | 产品事实账本（过期状态按当天重新计算） |
| `POST /api/evidence/facts/{id}/state` | 人工确认 / 更正事实 |
| `POST /api/evidence/gate` | 对已生成草稿运行发布闸门 |

**确定性与模型辅助的边界（重要）**

- 文本类文档（PDF 文本层、TXT/MD、CSV、XLSX）走**确定性解析**，逐条标注 `deterministic`。
- 图片没有文本层，且未启用 OCR：只读取像素尺寸，摘录为空，标注 `manual_review`。
  **图片不会自动把任何事实转为已核实**，必须人工阅读确认。
- 抽取只说明「文档写了什么」，**永远不会自动产生 `verified` 事实**；
  只有人工确认才会转为已核实。这条规则由后端强制，前端没有绕过路径。
- 本工具不对证据的法律效力作任何判断，也不代表平台审核结论。

**事实状态**：`verified` / `needs_review` / `unsupported` / `conflicting` / `expired`。
两份来源数值不一致 → `conflicting`；支撑证据全部过期 → `expired`；
证据文件被移除 → 相关事实退回 `unsupported`，且该文件的取值不再参与冲突判定。

**闸门规则**：材质、认证、安全、性能、环保、数值类宣称无证据支撑即**阻断**；
冲突与过期证据阻断依赖它的字段；无事实风险的普通营销文案不进入闸门。
数值类宣称同时核对具体值，例如已核实的 `350 ml` 证据不会放行 `500 ml` 文案。
平台政策校验与证据校验是两条独立的轴，在界面上分开呈现，互不替代。

演示数据见 `demo/evidence/`（全部虚构，不得描述为官方证书或官方政策）。

## 自愈式 Listing CI/CD

当 SKU 事实（品名 / 卖点）或平台政策变化时：

| 步骤 | 接口 | 说明 |
|---|---|---|
| 政策快照 | `GET /api/policy/snapshots` | 版本化政策包（current / candidate / historical），含出处 URL、生效日、摘录日。 |
| 政策 diff | `GET /api/policy/diff?base=&candidate=` | 确定性比较，返回新增 / 移除 / 变更（旧值 → 新值）。不调用模型。 |
| 影响面分析 | `POST /api/migration/impact` | 哪些产物受影响 / 不受影响、原因（SKU 事实 / 政策 / 两者）、需重编译 / 可复用的字段。 |
| 影子编译 | `POST /api/migration/candidate` | 只针对受影响的平台 / 字段，请求模型返回 **JSON patch**（未配置模型时走确定性回退）。当前产物不被改写。 |
| 最小应用 | `POST /api/migration/apply` | 仅写入已批准字段，其余逐字节保留；重跑校验；未解决项保持「需人工复核」。 |
| 回滚 | `POST /api/migration/rollback` | 确定性还原，不调用模型。 |
| 迁移报告 | `POST /api/migration/report`（`?format=html` 可读版） | 旧 / 新规则版本、变更规则、出处、受影响 / 未受影响计数、改写 / 保留字段、待人工项、前后校验、状态、时间戳。 |

画布上的「规则变更 / 迁移」面板串起这套流程，并内置两个确定性本地演示场景（Amazon 2025
真实历史政策迁移回放 / SKU 事实漂移）。政策回放基于 Amazon 2025-01-21 官方标题规则，
不虚构未来平台政策。
详见 `docs/PRODUCT.md`。

## 批量迁移中心（Phase 2）

单 SKU 的影响面分析扩展到整个组合。画布顶部「批量迁移中心」。

| 接口 | 说明 |
|---|---|
| `GET /api/portfolio/template` | 下载导入模板（模板本身即合法输入） |
| `POST /api/portfolio/import` | 导入 CSV / XLSX，逐行校验；坏行只报错不丢好行 |
| `POST /api/portfolio/impact` | 组合级影响面：SKU × 平台 × 字段 × 状态 × 原因 |
| `POST /api/portfolio/apply` | 批量应用；`review_required` 行会被拒绝而非静默应用 |
| `POST /api/portfolio/rollback` | 回滚整批，或只回滚一个 SKU |
| `POST /api/portfolio/report` | 审计报告 JSON（`?format=html` 可读版） |

行状态：`unaffected` / `safe_patch` / `review_required` / `blocked` / `applied` / `rolled_back`，
计数全部由真实分析结果得出，不是写死的示例数字。

导入列：`sku`、`product_name`、`selling_points`（`|` 或换行分隔）、`platforms`（`;` 分隔）、
`evidence_sources`（可选）。演示组合见 `demo/evidence/portfolio.csv`（含一行故意写坏的数据）。

**边界**：批量应用只改写本地产物，随时可回滚；本工具不做任何平台发布动作。
`review_required` 的补丁不能通过批量批准通道应用，必须逐项人工处理。

## 画布操作 Agent

右侧 Agent 不再只是聊天框：它可以改画布，但**改动必须先经过你的确认**。

固定流程：**你提要求 → Agent 给结构化计划 → 卡片列出将发生的每一步 → 你批准 →
前端校验并在一个事务里应用 → 生成需要再确认一次 → 结果可定位、可撤销。**

- **计划是数据，不是代码。** `POST /api/agent/chat` 返回 `{reply, plan}`，`plan.operations`
  只允许 `create_node` / `update_node` / `connect_nodes` / `focus_nodes` / `run_nodes` 五种，
  节点类型只允许 `sku_listing` / `image_generation` / `video_generation`，字段走白名单。
  模型永远不会返回可执行内容，前端也不会 eval 任何模型输出。
- **两道校验。** 后端 `api/agent_plan.py` 与前端 `web/src/station/agent/validate.ts` 各校验一次；
  真正保护画布的是前端那道（节点/端口是否存在、端口数据类型是否兼容、是否成环、
  操作数与新建节点数上限、`run_nodes` 未确认不得执行）。确定性回退计划走**同一套**校验，
  没有特权通道。
- **应用是一个事务。** `apply.ts` 在单个 `editor.run()` 里完成，任一步失败即整体回滚，
  画布保持原样。应用成功后可「定位改动」「运行这些节点」「撤销本次操作」。
- **预览不写画布。** 「在画布预览」只画一层只读投影覆盖层，取消即消失。
- **生成要第二次确认。** 弹窗写明预计模型调用次数与费用，并明确不会发布到任何平台。
- **Agent 看不到图片字节。** 发送给模型的画布上下文里，图片/视频字段被替换为
  `{count, mimeType, approxBytes}` 描述；客户端在发送前再检查一次，发现 data URL 直接中止。
- **产品文案与证据文档一律当作数据。** 上下文以「不可信数据」块包裹，其中的指令不被执行。
- **政策迁移不在对话里做。** 问到政策变更时，Agent 把你指回「规则变更 / 迁移」与
  「批量迁移」面板 —— 迁移引擎只有一套，不在 Agent 里重造。

Agent 只在前端真正应用成功之后才会说「已应用」；生成结果以节点自身状态为准，
Agent 不代替节点报成功，也永远不会写「已发布」。

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
