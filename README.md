# dumate2api

> 架构与实现细节见 [ARCHITECTURE.md](ARCHITECTURE.md)，完整操作说明见 [用户使用手册](docs/USER_MANUAL.md)。

![license](https://img.shields.io/badge/license-MIT-green)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Docker-blue)
![gateway-deps](https://img.shields.io/badge/gateway%20deps-0-brightgreen)

**五条上游，三协议网关。** 把百度搭子（DuMate）、千问办公、TRAE Work、Qoder、WorkBuddy 统一转换为 **OpenAI / Anthropic / Google 兼容 API**，供 Codex CLI、Claude Code、cc-switch 等客户端使用。

Docker 部署只发布一个端口：管理页面和模型 API 共用 `9080`。所有模型端点强制校验 API Key；项目同时提供账号与凭证管理、签到、积分、额度和请求日志。

<p align="center">
  <img src="assets/screenshots/dashboard.png" alt="管理端仪表盘" width="860" />
</p>

## 主要能力

- **OpenAI / Anthropic / Google 兼容**：覆盖 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 与 Google Generative Language。
- **五通道路由**：通过模型名前缀显式选择上游，未知前缀返回 `400`，不做静默回落。
- **凭证自持**：网关进程内直连上游，不依赖官方桌面程序常驻；Qwen 与 Qoder 的签名逻辑在本地完成。
- **强制鉴权**：管理端签发的 `dmk_...` 密钥或 `DUMATE2API_KEY` 环境密钥才能访问模型端点。
- **管理能力**：账号登录、模型与额度、签到详情、积分流水、用量统计、请求日志、聊天测试台、区域视图。
- **Docker 部署**：单个容器同时运行网关与管理端，前端在镜像构建阶段生成，数据统一持久化到 `./data`。

## 架构

```mermaid
flowchart LR
  OA[OpenAI / Responses] --> GW[dumate2api]
  AN[Anthropic] --> GW
  GG[Google Generative Language] --> GW
  GW --> DM[DuMate]
  GW --> QW[QwenWork]
  GW --> TW[TRAE Work]
  GW --> QD[Qoder]
  GW --> WB[WorkBuddy]
```

## Docker 部署

推荐使用 Docker Compose。镜像会在构建阶段生成管理端前端，并在同一个容器中启动管理端与内部模型网关。

```powershell
Copy-Item .env.example .env
docker compose up -d --build
docker compose ps
```

唯一公开入口：

```text
http://127.0.0.1:9080
```

- `/` 和 `/api/admin/*`：管理页面与管理 API
- `/v1/*`、`/v1beta/*`、`/responses`、`/messages` 等：模型 API
- `/health`、`/ping`、`/metrics`：健康检查与指标

容器内的模型网关监听 `127.0.0.1:18081`，仅供同容器管理端转发，不会发布到宿主机。宿主机端口映射始终只有一个。

首次启动时，管理端会在容器日志中打印一次 `admin` 初始密码：

```powershell
docker compose logs -f dumate2api
```

容器默认共享 `/app/data`，宿主机对应目录为 `./data`。停止服务不会删除账号、Cookie、API Key、日志或管理员状态：

```powershell
docker compose down
```

### 自定义端口与数据目录

默认配置可直接运行。需要修改端口、监听地址或数据目录时，创建本地 `.env`：

```powershell
Copy-Item .env.example .env
```

编辑 `.env` 后重新启动：

```powershell
docker compose up -d
```

常用 Compose 变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DUMATE_BIND_ADDR` | `127.0.0.1` | 唯一公开端口的宿主机监听地址 |
| `DUMATE_GATEWAY_PORT` | `9080` | 唯一公开端口的宿主机端口 |
| `DUMATE_DATA_DIR` | `./data` | 账号、密钥、日志和管理状态的持久化目录 |
| `DUMATE_IMAGE` | `dumate2api:local` | Compose 使用的镜像名 |

远程服务器部署时，在 `.env` 中设置：

```dotenv
DUMATE_BIND_ADDR=0.0.0.0
DUMATE_GATEWAY_PORT=9080
```

然后访问 `http://<服务器IP>:9080`。公网环境必须在防火墙或反向代理层再加 TLS、来源限制和访问控制；管理端登录 Cookie 不应长期通过明文 HTTP 传输。

### 容器中的账号登录

容器不需要图形桌面，也不会把百度登录页代理到服务器。浏览器登录由用户电脑上的 Windows 登录助手完成：

1. 打开管理端，进入“账号管理 → 添加账号 → 浏览器登录助手”。
2. 下载登录助手 ZIP 并解压。压缩包包含 `start-login-helper.cmd`、`dumate-login-helper.ps1` 和说明文件。
3. 在管理页生成一次性配对码。配对码 15 分钟内有效，只能使用一次。
4. 双击 `start-login-helper.cmd`，输入当前管理端地址和配对码。
5. 助手会用独立的临时 Chrome/Edge 配置打开真实百度登录页。完成登录后，助手读取 Cookie 并提交给管理端。

登录助手直接连接用户指定的管理端，不依赖浏览器插件，也不经过服务器端百度登录代理。服务端会调用上游账号信息接口验证，验证成功后才会写入账号池；配对码和 Cookie 不会出现在轮询接口中。

桌面端认证文件上传作为备用方式。先在 DuMate 桌面端完成登录，再在管理页选择下面两个文件：

```text
%APPDATA%\qianfan-desktop-app\auth.json
%APPDATA%\qianfan-desktop-app\.cookie-key
```

`.cookie-key` 是隐藏文件，可在资源管理器开启“显示隐藏的项目”，或按 `Win+R` 输入 `%APPDATA%\qianfan-desktop-app` 直接打开目录。服务端解密后只保存可用的登录 Cookie，原始上传文件不会落盘。

账号上游仍共用 `DUMATE_PROXY`。如果容器访问百度接口需要代理，请在 `.env` 中配置容器内可达的代理地址：

```dotenv
DUMATE_PROXY=http://172.17.0.1:7897
```

容器里的 `127.0.0.1` 指容器自身，不能直接访问宿主机代理。Linux 可用 Docker 网桥地址（常见为 `172.17.0.1`）或宿主机内网地址；macOS / Windows 可使用 `host.docker.internal`。修改后必须重建并重启容器：

```powershell
docker compose up -d --build
docker compose logs -f dumate2api
```

登录助手不经过服务器登录代理页，但最终账号验证仍由容器访问百度接口。若返回网络错误，先检查容器到百度接口或代理的连通性：

- `ENOTFOUND` / `EAI_AGAIN`：容器 DNS 或代理域名解析失败。
- `ECONNREFUSED`：代理地址不可达，或代理端口写错。
- `ETIMEDOUT` / `ECONNRESET`：容器到代理的网络超时，或被代理主动断开。

只重启旧容器不会更新镜像或登录助手下载包；拉取新代码后要使用 `docker compose up -d --build`。

## 首次登录与 API Key

1. 打开 `http://127.0.0.1:9080`，用户名使用 `admin`。
2. 从 `docker compose logs` 取得首次启动时打印的随机密码并登录。
3. 在“账号管理”中切换到目标通道，添加账号、完成 OAuth，或导入 Cookie / Token。
4. 在“API Key”页面创建密钥并妥善保存。签发的密钥形如 `dmk_...`。
5. 也可以在 `.env` 中设置固定密钥 `DUMATE2API_KEY=...`，然后执行 `docker compose up -d` 使其生效。

> **鉴权已强制开启。** 除 `/health`、`/ping` 等探针外，所有模型端点都必须带密钥。`DUMATE_REQUIRE_KEY` 已废弃；即使设为 `0`，也只会打印警告，不能关闭鉴权。

同一端口上的健康检查：

```powershell
curl http://127.0.0.1:9080/health
```

最小请求示例：

```powershell
$env:DUMATE_API_KEY = 'dmk_...'
curl.exe http://127.0.0.1:9080/v1/chat/completions `
  -H "Authorization: Bearer $env:DUMATE_API_KEY" `
  -H "Content-Type: application/json" `
  -d '{"model":"model-text","messages":[{"role":"user","content":"hello"}]}'
```

## 通道与模型路由

| 通道 | 模型前缀 | 上游 | 凭证方式 | 官方客户端 |
|---|---|---|---|---|
| 百度搭子（DuMate） | 无前缀，默认 | 网页接口 / 本地 `:8980` | 网页 Cookie；可选桌面登录态 | 否 |
| 千问办公（QwenWork） | `qwen/` | 云端网关，进程内直连 | OAuth Device Flow | 否 |
| TRAE Work | `traework/` | 云端网关，进程内直连 | OAuth | 否 |
| Qoder | `qoder/` | 云端网关，进程内直连 | OAuth Device Flow | 否 |
| WorkBuddy | `workbuddy/` | 腾讯 Copilot 系，国内 / 国际双区域 | 浏览器 OAuth、认证文件导入或 Token 粘贴 | 否 |

| 调用方传的模型名 | 路由到 |
|---|---|
| `model-text`、`glm-5` 等无前缀模型 | 百度搭子 |
| `qwen/pro`、`qwen/flash` | 千问办公 |
| `traework/glm-5.2` | TRAE Work |
| `qoder/gfmodel` | Qoder |
| `workbuddy/<模型 ID>` | WorkBuddy，区域由账号决定 |
| 未知前缀，如 `qwn/pro` | **返回 400，不静默回落** |

WorkBuddy 支持国内与国际区域，实际可用模型以管理端和 `GET /v1/models` 为准。Qoder 零额度时聊天可能挂起，使用前先确认签到与余额；其模型倍率差异较大，调试时优先选择低倍率档。

## 客户端配置

| 客户端 | API 格式 | Base URL | Key | 模型 |
|---|---|---|---|---|
| Claude Code | Anthropic | `http://127.0.0.1:9080`，不要追加 `/v1` | `dmk_...` | `model-text` |
| Codex CLI | OpenAI Responses | `http://127.0.0.1:9080/v1` | `dmk_...` | `model-text` |
| 通用 OpenAI 客户端 | Chat Completions | `http://127.0.0.1:9080/v1` | `dmk_...` | `model-text` |
| Google 客户端 | Generative Language | `http://127.0.0.1:9080` | `dmk_...` | 通过 `/v1beta/models` 获取 |

Codex CLI `config.toml` 示例：

```toml
model_provider = "dumate"
model = "model-text"

[model_providers.dumate]
name = "DuMate local proxy"
base_url = "http://127.0.0.1:9080/v1"
wire_api = "responses"
env_key = "DUMATE_API_KEY"
```

启动 Codex 前设置环境变量：

```powershell
$env:DUMATE_API_KEY = "dmk_..."
```

Claude Code 常用环境变量：

```bash
export ANTHROPIC_BASE_URL='http://127.0.0.1:9080'
export ANTHROPIC_AUTH_TOKEN='dmk_...'
export ANTHROPIC_MODEL='model-text'
```

## API 端点

| 端点 | 协议 / 用途 |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/responses`、`POST /responses` | OpenAI Responses，Codex CLI 使用 |
| `POST /v1/messages`、`POST /messages` | Anthropic Messages |
| `GET /v1beta/models` | Google 模型列表 |
| `POST /v1beta/models/{model}:generateContent` | Google Generative Language |
| `GET /v1/models` | 当前网关可用模型列表 |
| `GET /health`、`GET /ping` | 健康检查，无需 API Key |

## 本地运行

要求 Node.js 18 或更高版本。管理端前端源码在 `web/`，`web/dist` 未提交，因此首次本地运行必须先构建：

```powershell
corepack enable
pnpm install
pnpm --dir web install
pnpm --dir web run build
```

终端一启动内部模型网关：

```powershell
$env:DUMATE2API_HOST = '127.0.0.1'
$env:DUMATE2API_PORT = '18081'
pnpm start
```

终端二启动唯一公开入口：

```powershell
$env:DUMATE_ADMIN_HOST = '127.0.0.1'
$env:DUMATE_ADMIN_PORT = '9080'
$env:DUMATE_ADMIN_GATEWAY_PORT = '18081'
pnpm run admin
```

本地开发同样只访问 `http://127.0.0.1:9080`。管理端会把模型请求转发到内部网关 `18081`。若管理端提示 `web/dist/index.html missing`，说明前端尚未构建。

Windows 日常开发可以使用：

```bat
start-dev.bat
```

该脚本同时启动公开入口 `9080` 和内部模型网关 `18081`。

## 管理端

<p align="center">
  <img src="assets/screenshots/models.png" alt="模型管理" width="420" />
  <img src="assets/screenshots/usage.png" alt="用量统计" width="420" />
  <img src="assets/screenshots/points.png" alt="积分明细" width="420" />
</p>

<p align="center">
  <img src="assets/screenshots/checkin.png" alt="签到详情（按月/按年）" width="860" />
</p>

<p align="center"><sub>签到详情：每个账号的当月日历与全年各月汇总，切换月份即可回看。</sub></p>

<p align="center">
  <img src="assets/screenshots/tasks-lottery.png" alt="签到、任务与抽奖" width="860" />
</p>

<p align="center"><sub>账号管理页：一键签到 / 单账号签到与抽奖 / 跑任务 / 一键抽奖，后台自动轮询的间隔策略如实展示；任务记录并入积分明细的操作流水。</sub></p>

顶栏切换通道，各页面据此显示对应数据。

| 页面 | 回答什么问题 |
|---|---|
| 仪表盘 | 各通道健康、用量、账号状态、即将过期积分 |
| 模型管理 | 有哪些模型、上下文/输出上限、倍率、额度还剩多少 |
| 积分明细 | 积分从哪来、怎么没的；签到详情按月/按年查看 |
| 用量统计 / 请求日志 | 趋势与逐条明细（含每条请求花的积分） |
| API Key / 账号管理 / 聊天测试台 | 签发密钥 / 增删账号跑任务 / 在管理端内调试模型 |

> **五条通道的额度与账本相互独立，不能直接相加**：DuMate 依赖上游账单与余额游标，QwenWork 是积分池，TRAE 按账号计 credits，Qoder 区分订阅与赠送额度，WorkBuddy 按国内 / 国际账号和套餐计算。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DUMATE2API_HOST` / `DUMATE2API_PORT` | `127.0.0.1` / `9080` | 内部模型网关监听地址与端口；Docker 中为 `127.0.0.1:18081`，不发布到宿主机 |
| `DUMATE2API_KEY` | 空 | 可选的固定网关密钥；与管理端签发的密钥同时有效 |
| `DUMATE_REQUIRE_KEY` | 已废弃 | 不能关闭鉴权；设为 `0` 仅触发启动警告 |
| `DUMATE_ADMIN_HOST` / `DUMATE_ADMIN_PORT` | `127.0.0.1` / `9080` | 唯一公开入口的监听地址与端口 |
| `DUMATE_ADMIN_GATEWAY_PORT` | `18081` | 管理端转发到的内部模型网关端口 |
| `DUMATE_ADMIN_DATA` | `data` | 管理端数据目录 |
| `DUMATE_DUMATE_SOURCE` | `web` | DuMate 凭证来源；`web` 只用网页凭证，`auto` 为桌面优先并回落网页 |
| `DUMATE_QWENWORK_AUTOSTART` / `DUMATE_TRAEWORK_AUTOSTART` / `DUMATE_QODER_AUTOSTART` | `auto` | 设为 `off` 可关闭对应通道自动启动 |
| `DUMATE_AUTO_CHECKIN_HOUR` / `DUMATE_AUTO_CHECKIN_MINUTE` | `9` / `17` | 每日自动签到时间，两个变量需同时设置 |
| `DUMATE_CORS_ORIGINS` | 空 | 管理端 CORS 白名单；默认为 fail-closed |
| `DUMATE_PROXY` | 空 | 容器出站代理，仅用于访问上游接口；不代理百度登录页 |

完整变量表与通道协议说明见 [CLAUDE.md](CLAUDE.md) 和 `docs/CHANNEL-*.md`。

## 测试与验证

```bash
npm test            # 离线 Node 单元测试
npm run test:smoke  # 在线冒烟测试，默认访问网关 9080
npm run verify      # 综合验证，按输出确认各脚本的在线依赖
```

常用离线验证：

```bash
node test/verify-qoder-cosy.js
node test/verify-checkin-detail.js
node test/verify-fallback-stream-pipe.js
```

更多脚本见 `test/verify-*.js`。修改对应模块后，先运行相关离线验证，再运行在线冒烟测试。

## 数据与凭证

| 文件 | 内容 | 敏感度 |
|---|---|---|
| `keys.json` | 管理端签发的 API Key，保存 SHA-256 与完整明文 | 高 |
| `web-accounts.json` | DuMate 网页账号与 Cookie，Cookie 明文保存 | 高 |
| `qwenwork-accounts.json` | QwenWork OAuth 凭证与 refresh token | 高 |
| `traework-accounts.json` | TRAE Work 凭证与 refresh token | 高 |
| `qoder-accounts.json` | Qoder 凭证与 refresh token | 高 |
| `workbuddy-accounts.json` | WorkBuddy 国内 / 国际账号、Token 与区域信息 | 高 |
| `admin-users.json` / `admin.secret` | 管理员口令与会话密钥 | 高 |

`data/` 已加入 `.gitignore`。不要把 `data/` 提交到 Git、打包进镜像、上传到网盘或放入公开备份。Cookie 和 refresh token 被复制后通常可以直接使用账号额度。

## 安全建议

- 默认只监听 `127.0.0.1`。需要远程访问时，在反向代理后启用 TLS、身份认证和来源限制。
- API Key 仍需按客户端分配，避免所有调用方共用一个长期密钥。
- 停止服务后再备份 `data/`，并限制备份文件权限。
- 定期检查账号状态、额度、请求日志和异常来源 IP。

## 许可证

[MIT](LICENSE)

---

**免责声明**：本项目是独立的第三方开源项目，与百度、阿里（千问办公、Qoder）、字节（TRAE）、腾讯（WorkBuddy）及 Anthropic、OpenAI、Google 等主体无隶属、合作或背书关系。项目通过协议适配与本机凭证互操作，不破解、不绕过任何付费墙或授权机制，不分发上游二进制资产，也不上传用户数据。凭证与日志只保存在本机。上游协议可能变化，积分自动化也可能违反服务条款并导致账号受限，使用风险由使用者自行承担。本项目按“现状”提供，不附带任何明示或暗示担保。
