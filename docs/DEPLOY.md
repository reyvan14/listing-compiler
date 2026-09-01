# 部署说明（Deployment）

跨境上架编译器 = 一个 FastAPI 后端（`api/`，端口 8788）+ 一份前端构建产物（`web/dist/`）。
`api/app.py` 在检测到 `web/dist/` 存在时直接托管前端，因此生产环境通常只需运行一个
uvicorn 进程。

本文档覆盖 **Token Plan（指定模型）** 接入后的部署要点。

---

## 1. 前置条件

- Python ≥ 3.10（已在 3.12 验证），后端依赖见 `api/requirements.txt`。
- Node ≥ 22.12（tldraw 5 要求）+ yarn，仅用于构建前端。
- 目标服务器：`root@8.147.60.177`。**所有部署 SSH 命令都必须使用专属部署私钥
  `~/.ssh/listing_deploy`**（其公钥已安装到服务器）。不要复制、打印、查看或以任何方式暴露该私钥。
- 连通性自检（获得访问权限后先跑这一条）：

  ```bash
  ssh -i ~/.ssh/listing_deploy -o BatchMode=yes root@8.147.60.177 'hostname'
  ```

  在此命令成功之前，不要部署、也不要在服务器上配置任何真实 API Key。

---

## 2. 环境变量

后端在启动时读取环境变量（`api/envutil.py` 也会加载同目录 `api/.env`，但真实环境变量优先）。
**Token Plan 的 Key 必须放在仓库之外。**

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `TOKEN_PLAN_API_KEY` | ✅ | — | 专属 Key。仅放在服务器上、不进 Git、不打印、不写日志。 |
| `TOKEN_PLAN_BASE_URL` | | `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | 专属 base URL。**不要**用通用 `dashscope.aliyuncs.com`，否则不消耗 Token Plan 额度。 |
| `TOKEN_PLAN_TEXT_MODEL` | | `qwen3.7-plus` | 生成三台草稿用的文本模型。可改为任意 Token Plan 文本模型。 |
| `TOKEN_PLAN_AGENT_MODEL` | | `qwen3.7-plus` | 工位 Agent 用的模型。 |
| `TOKEN_PLAN_TIMEOUT_S` | | `60` | 单次 chat 读超时（秒）。超时即回退本地草稿。 |
| `TOKEN_PLAN_CONNECT_TIMEOUT_S` | | `10` | 连接超时（秒）。 |
| `LISTING_UPSTREAM_URL` | | — | 可选网关层，设置后在 Token Plan 之前尝试。 |
| `LISTING_LLM_API_KEY` / `LISTING_LLM_BASE_URL` / `LISTING_LLM_MODEL` | | — | 旧的通用 OpenAI 兼容覆盖项，向后兼容保留；仅当对应 `TOKEN_PLAN_*` 未设置时生效。 |

图片 / 视频 Provider（`LISTING_IMAGE_*` / `LISTING_VIDEO_*`）**未纳入本次 Token Plan 接入**，保持原样。

### 选择默认模型的理由

仓库未指定某个确切模型（原默认是 `qwen-plus`）。本次选 **`qwen3.7-plus`**：与官方示例一致、
属于较快的 "plus" 档，避免默认返回 reasoning、响应更慢的 `qwen3.6` 变体。可随时用
`TOKEN_PLAN_TEXT_MODEL` / `TOKEN_PLAN_AGENT_MODEL` 覆盖，无需改代码。

---

## 3. 在服务器上安全放置 Key（仓库之外）

> **Key 轮换（上线前必做）**：此前在协作过程中出现过的 Token Plan Key 应视为**已泄露**，
> 在跑真实模型测试之前必须在 Token Plan 控制台**吊销并重新签发**。新 Key 只写入下面的
> 服务器环境文件，**绝不**硬编码、提交、打印或写入日志。仓库里只有变量名 `TOKEN_PLAN_API_KEY`，
> 没有任何 Key 值；`api/token_plan.py` 在调用时才从环境变量读取，失败日志只含
> `request_id / status / category`。

推荐用 systemd 的 `EnvironmentFile`：

```bash
# 服务器上，root
install -m 600 /dev/null /etc/listing-compiler.env
cat > /etc/listing-compiler.env <<'EOF'
TOKEN_PLAN_API_KEY=<在此粘贴专属 Key>
TOKEN_PLAN_BASE_URL=https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
TOKEN_PLAN_TEXT_MODEL=qwen3.7-plus
TOKEN_PLAN_AGENT_MODEL=qwen3.7-plus
EOF
chmod 600 /etc/listing-compiler.env
```

- `/etc/listing-compiler.env` 不在 Git 仓库内、权限 600、仅 root 可读。
- 不要 `echo $TOKEN_PLAN_API_KEY`、不要写进 shell history（用 `cat > file <<'EOF'` 或编辑器）。
- 校验（不打印 Key）：`grep -c TOKEN_PLAN_API_KEY /etc/listing-compiler.env` 应为 `1`。

systemd unit 片段：

```ini
# /etc/systemd/system/listing-compiler.service（示例；以服务器现有 unit 为准）
[Service]
WorkingDirectory=/opt/listing-compiler/api
EnvironmentFile=/etc/listing-compiler.env
ExecStart=/opt/listing-compiler/.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8788
Restart=on-failure
```

---

## 3a. 前端 API 地址与跨域（CORS）

前端所有 API 调用都经由单一客户端 `web/src/station/apiClient.ts` 解析地址：

- **默认**：同源相对路径 `/api/...`（FastAPI 直接托管 `web/dist` 时用这个，无需 CORS）。
- **可选覆盖**：构建时设 `VITE_LISTING_API=https://api.example.com`，则 listing / agent /
  media / rules 全部请求 `https://api.example.com/api/...`（见
  `web/src/station/secondOriginResolution.test.ts`）。

当 `VITE_LISTING_API` 指向**与页面不同的源**时，后端必须允许该源跨域：

```python
# api/app.py 的 CORS 中间件（当前为 allow_origins=["*"]，可用但过宽）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://<部署页面的源>"],   # 收敛到实际前端源
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
```

同源部署（默认）不需要改 CORS。仅当前端与 API 分离部署时按上面收敛 `allow_origins`。

---

## 4. 构建前端

```bash
cd web
yarn install --frozen-lockfile
yarn build          # tsc -b && vite build —— 两步都必须通过
```

`yarn typecheck`（`tsc -b`）与 `yarn build` 现在都干净通过（0 error）。历史遗留的 21 个 `tsc`
错误已在本轮修复：扩展了 `lib/pipeline-spec.ts` 的类型契约以匹配其消费方、删除三处指向未注册
节点类型（`capture` / `message`）的死分支、把 `SkuListingNode.tsx` / `ListingResultNode.tsx`
改用与同目录其它节点一致的 `export type X = T.TypeOf<typeof X>` 声明。未使用 `any` 强转、
`ts-ignore` 或关闭任何检查。`yarn build:app` / 直接 `vite build` 只是省去类型检查的快捷方式，
不作为发布判据。

---

## 5. 更新与重启（保留数据、可回滚）

> 登录服务器执行以下步骤：`ssh -i ~/.ssh/listing_deploy root@8.147.60.177`。
> 任何 `ssh` / `scp` / `rsync` 到该服务器的命令都使用 `-i ~/.ssh/listing_deploy`。
> 变更前先按第 3 节完成备份（应用代码、systemd unit、环境文件、反向代理配置）。

```bash
# 服务器上，root。以下路径按服务器实际情况调整。
APP=/opt/listing-compiler
TS=$(date +%Y%m%d-%H%M%S)

# 5.1 备份当前部署配置与代码（不删任何数据）
cp -a /etc/systemd/system/listing-compiler.service /etc/systemd/system/listing-compiler.service.bak-$TS 2>/dev/null || true
cp -a /etc/listing-compiler.env                    /etc/listing-compiler.env.bak-$TS
cp -a "$APP"                                        "$APP.bak-$TS"      # 或用 git tag/branch 标记当前 commit

# 5.2 拉取新代码
cd "$APP" && git fetch origin && git checkout <verified-commit>

# 5.3 后端依赖
"$APP/.venv/bin/pip" install -r api/requirements.txt

# 5.4 前端构建
cd "$APP/web" && yarn install --frozen-lockfile && yarn vite build

# 5.5 仅重启后端服务
systemctl daemon-reload
systemctl restart listing-compiler
systemctl --no-pager status listing-compiler
```

### 回滚

```bash
systemctl stop listing-compiler
rm -rf /opt/listing-compiler && mv /opt/listing-compiler.bak-$TS /opt/listing-compiler
cp -a /etc/listing-compiler.env.bak-$TS /etc/listing-compiler.env
cp -a /etc/systemd/system/listing-compiler.service.bak-$TS /etc/systemd/system/listing-compiler.service
systemctl daemon-reload && systemctl start listing-compiler
```

---

## 6. 部署后健康检查

```bash
# 后端存活
curl -fsS http://127.0.0.1:8788/health                 # 期望 {"ok":true}
curl -fsS http://127.0.0.1:8788/api/rules | head -c 80  # 期望三台规则 JSON

# 生成链路（未配 Key 时 source=fallback；配了 Key 且成功时 source=llm）
curl -fsS -X POST http://127.0.0.1:8788/api/listing/generate \
  -H 'Content-Type: application/json' \
  -d '{"product_name":"Foldable Cup","points":"folds\nleak proof","platforms":["amazon"],"asset_mode":"compliant","uploads":[]}' \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("code",d["code"],"source",d["data"]["source"],"drafts",[x["id"] for x in d["data"]["drafts"]])'

# Token Plan 连通性自检（不打印 Key / prompt / 响应正文）
cd /opt/listing-compiler/api && ../.venv/bin/python scripts/check_token_plan.py
```

服务日志里 Token Plan 失败只会出现 `request_id` / `status` / `category`，不会有 Key、
Authorization 头、prompt 或模型响应正文。

---

## 7. 本地验证命令（部署前）

```bash
# 后端
cd api && pip install -r requirements.txt -r requirements-dev.txt && pytest

# 前端：类型检查 + 生产打包 + 单测 + 浏览器 E2E
cd web && yarn install --frozen-lockfile
yarn typecheck        # tsc -b —— 0 error
yarn build            # tsc -b && vite build
yarn test             # vitest
yarn test:e2e         # playwright，用 uvicorn 托管 web/dist
```

E2E 需要 Node ≥ 22.12 与 Playwright 的 Chromium（`npx playwright install chromium`）。

---

## 8. 已知限制 / 待办

- `api/` 无既有 lint 配置；本轮用 `pyflakes` 做静态检查（干净）。
- tldraw 仍使用内嵌 eval 许可证 + `vite.config.ts` 的 `keepTldrawEditor` transform；
  升级 tldraw 补丁版本可能使该 transform 失效，应改为正式许可证 Key（走环境变量）。
- 生产包体 `index.js` ≈ 2 MB（gzip ≈ 625 KB），未做代码分割。
- 取消（Cancel）会中止在途 listing 请求并阻止结果落地；但 Agent / 媒体节点的在途请求
  目前只受各自超时约束，没有单独的取消按钮。
