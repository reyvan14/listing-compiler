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

## 可编辑的上新审核与审批（Phase 1A）

生成结果是**提案**，不是答案。每份平台文案都会成为一条可审核的修订，走同一条生命周期：

```
draft → in_review → needs_changes → validated → approved → superseded / rolled_back
```

在检查器的「审核」标签页里编辑标题、卖点、描述与关键词，并按字段查看差异
（未变 / 新增 / 删除 / 修改）。三条规则由后端强制，前端没有绕过路径：

- **不静默覆盖。** `draft` 是操作者的工作副本，可原地修改；一旦有人对它做过动作
  （提交校验、批准、被取代），保存修改会派生**新的候选修订**，已批准的版本原样保留。
- **确定性不会凭空出现。** 修改内容会作废按旧文案算出的校验结论；批准时会**重新运行**
  确定性校验（`checker.apply_checks`，与生成时同一套规则），只要还有阻断项就直接拒绝。
- **历史只增不减。** 回滚不是删除，而是以**新修订**还原选定版本的内容；被回滚掉的版本
  标记为 `rolled_back` 并继续可读。同一个 SKU + 平台同时只有一条 `approved` 修订，
  更早的转为 `superseded`。

警告可以豁免，但必须留下**复核人、理由、时间、修订号与具体警告 ID**；
本次校验没有报过的警告无法被「确认」，阻断项不能当作警告放行。
审批记录会写下审批人、决定、理由、所依据的校验编号与政策快照 ID。

| 接口 | 说明 |
|---|---|
| `POST /api/review/revisions` | 登记生成结果为修订 1（同内容幂等，刷新不会伪造历史） |
| `GET /api/review/revisions` · `GET /api/review/revisions/{id}` | 修订列表 / 单条修订的完整视图 |
| `POST /api/review/revisions/{id}/draft` | 保存草稿（必要时派生新候选修订） |
| `POST /api/review/revisions/{id}/validate` | 提交确定性校验 |
| `POST /api/review/revisions/{id}/approve` · `/request-changes` | 批准 / 退回修改 |
| `POST /api/review/revisions/{id}/rollback` | 以新修订还原选定版本 |
| `POST /api/review/revisions/{id}/acknowledge` | 记录警告豁免 |
| `GET /api/review/diff?base=&target=` | 任意两条修订的字段级差异 |

修订账本与证据账本同作用域（按浏览器工作区 + 商品隔离），落盘在
`api/evidence_store/.../reviews.json`，原子替换写入，不入库。
**批准只代表内部复核通过**：本工具不做平台发布，也不代表任何平台的审核结论。

## 真实像素的图片合规检查（Phase 1B）

图片检查全部基于**解码后的图片本身**。提示词写了「纯白背景」、文件名叫 `white.png`、
生成模式选了 compliant——这些都不构成任何证据。

每张图（生成的和上传的走同一条路）会记录：内容 SHA-256、由**文件字节**推断的格式与 MIME、
宽高、精确约分的宽高比、字节数、色彩模式、是否含 alpha 通道、检查时间与方法版本。
空文件、截断、损坏、超限（20 MB / 50 MP）、不支持的格式，以及**声明类型与字节不符**的文件
一律拒绝；被拒绝的文件不会进入账本，也不会破坏已有的图片或修订。

**背景是量出来的。** 沿四条边按固定网格采样 96 个像素点，取各通道中位数作为背景估计
（中位数能扛住 logo 或产品边缘伸进采样带），一致度 = 与估计色相符的采样点占比
（容差 ±8/通道）。带透明通道的图会先合成到白底再测量——透明的角落不是白背景的证据，
但也不该被读成黑色。方法版本 `border-sample-median/v1` 随结果一起记录。

**判不了的就说判不了。** 结果状态有五种：`pass` / `fail` / `warning` /
`manual_review` / `unavailable`。主体占比、叠加文字与 logo 需要目标检测与 OCR，
本工具未启用，一律返回 `manual_review`，永远不会静默通过。界面上也不会因此显示「合规」：
可判定项全通过时的最好说法是「可机械判定的项均通过」。

规则来自**同一套版本化政策快照**（`api/policy/snapshots/*.yaml`），与文本规则并列，
新增 `image_format` / `image_min_dimensions` / `image_max_dimensions` / `image_max_bytes` /
`image_aspect_ratio` / `image_no_transparency` / `image_white_background` /
`image_subject_coverage` / `image_no_overlaid_text` 九种 rule kind。
每条结果都带 rule ID、政策快照 ID、实测值、要求值、判定方法与所属图片。
文本引擎不判定任何 `image_*` 规则，图片检查器不判定任何文本规则，两者结论互不顶替。

| 接口 | 说明 |
|---|---|
| `POST /api/media/assets/upload` | 上传图片并检查（multipart） |
| `POST /api/media/assets` | 登记并检查浏览器已持有的 data URL 图片 |
| `GET /api/media/assets` · `GET /api/media/assets/{id}` | 图片资产清单 / 单条记录 |
| `GET /api/media/assets/{id}/original` | 被检查的原始字节（供灯箱打开） |
| `POST /api/media/assets/{id}/verify` | 重新哈希并比对记录的 SHA-256 |

服务端**不会代为抓取任意 URL**：只接受 `data:` URL 与 multipart 上传，避免把检查接口
变成请求转发器。原图接口允许用 query 传作用域，因为 `<img src>` 带不了自定义头；
作用域是隔离键，不是凭证。

演示卡片使用的是 SVG 矢量占位图，没有可采样的像素，界面会如实说明需要真实的
PNG / JPEG 才能做像素级检查。

## 发布护照与交接包（Phase 1C）

护照回答六个问题，全部用**存下来的实体 ID**回答，不用界面上的文字回答：
交接的到底是什么、凭什么、依据哪个政策版本、谁批的、还差什么、能不能复现与校验。

护照绑定的是精确的实体：已批准的修订 ID 与内容指纹、逐字段哈希、图片资产 ID 与 SHA-256、
产品事实与它们引用的证据文件哈希、政策快照版本与规则哈希、校验与审批记录 ID。
任何一个实体不见了，护照会说它不见了，而不是拿记忆里的文字补上。

**就绪状态是算出来的**：`blocked` / `needs_review` / `ready_for_handoff` /
`exported` / `superseded`。以下任一情况直接阻断：没有已批准修订、确定性校验仍有阻断项、
证据闸门拒绝、图片检查未通过、图片文件丢失或校验和变化、已批准修订被编辑或取代。
构建护照时会**重新跑一遍校验**——昨天的批准不能证明今天的规则。
「需人工核验」的项目在任何状态下都保持可见，永远不会被折算成通过。

**导出是交接，不是发布。** 交接包是一个确定性 ZIP：条目排序固定、条目时间戳固定、
不写入导出时刻，因此同一份已存储的护照导出两次字节完全一致。包内含
`manifest.json`（每个文件的相对路径、字节数、SHA-256 与来源实体）、
`release-passport.json`、`listing.json`、`listing.md`、`validation-report.json`、
`evidence-index.json`、`approvals.json`、`policy-snapshots.json`、`README.md`
与 `media/`（已检查的图片原件）。所有路径由实体 ID 生成并经过归一化，
无法表达 `../`、绝对路径或重名。生成后会**重新打开并逐条重算哈希**，
校验通过才记为「已导出」。

导出需要显式二次确认（接口层面：不带 `confirm` 返回 428），确认框会说明
**不会发布到任何平台**，以及包内还剩多少项需人工核验、责任在谁。

| 接口 | 说明 |
|---|---|
| `POST /api/passport/build` | 按当前记录重新计算就绪状态并存储护照 |
| `GET /api/passport/list` · `GET /api/passport/{id}` | 护照列表 / 单份护照 |
| `GET /api/passport/{id}/manifest` | 预览交接包内容（**不会**记为已导出） |
| `POST /api/passport/{id}/export` | 导出交接包（需 `confirm: true`） |

市场、语言、币种与单位制在护照中标注为**由操作者声明、未经核验**——
本工具不会从产品数据里推断价格、币种或计量事实。

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

### 流式回复与执行过程

| 接口 | 说明 |
|---|---|
| `POST /api/agent/chat` | 非流式，返回 `{reply, plan}`。保持向后兼容，未改动。 |
| `POST /api/agent/chat/stream` | SSE（`text/event-stream`），事件：`meta` / `status` / `delta` / `warning` / `plan` / `heartbeat` / `error` / `done`。 |

- **真流式**：`api/token_plan.py` 用 provider 的 `stream: true` 协议，逐块解析 SSE，
  支持 `[DONE]`、容忍坏块、把前端的取消传导到 httpx 连接。日志只记录请求 id、
  状态码与错误类别，不记录提示词、输出、Key 或 Authorization 头。
- **回复与计划分流**：模型按
  `<assistant_reply>…</assistant_reply><agent_plan>{…}</agent_plan>` 输出。
  增量解析器会扣住任何可能是分隔符前缀的尾巴，因此**计划 JSON 永远不会以聊天文本出现**，
  哪怕分隔符正好被网络切成两半。计划先缓冲、校验通过后才作为 `plan` 事件发出；
  不完整或非法的计划只会被丢弃，不会变成可点击的卡片。
- **执行过程（不是「思考过程」）**：`understanding` / `reading_canvas` /
  `checking_evidence` / `planning` / `validating` / `ready` / `applying` /
  `generating` / `completed` / `failed` / `cancelled`。每一条都是产品真实做过、
  用户可核对的动作（读了几个节点、账本里各状态几条、按允许清单校验）。
  **模型的隐藏推理不会被请求、存储或展示**：`reasoning_content` 在 provider 边界就被丢弃。
  界面不显示编造的百分比。
- **为什么这样规划**：计划卡片上的折叠区，全部由后端从**已校验的计划**推导出的结构化字段
  组成（意图、平台、规划来源、节点用途、比例与时长、证据提示、预计调用次数、
  是否需要二次确认、不发布声明）。没有任何自由文本字段，因此推理内容无处可藏。
- **停止**：流式期间「发送」变为「停止」，走 `AbortController`，会真正断开上游请求。
- **降级**：只有在流式端点返回 404 / 405 / 非 SSE **且尚未收到任何有意义事件**时，
  才自动回落到非流式接口一次。已经出现过 delta / status / plan 之后不自动重发
  （否则重复计费），改为提供「重试」。
- **生成进度**：`正在生成 3/5` 来自 `ExecutionGraph` 中真实执行完成的媒体节点，不是计时器。

反向代理必须为该路径关闭缓冲，否则流式退化为一次性返回；配置见 `docs/DEPLOY.md` 3b。

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
