# GPT Token Extractor

自动化提取 OpenAI / Codex OAuth Token 的 Web 工具。

输入 OpenAI 邮箱，自动完成验证码登录，提取 OAuth access_token / refresh_token，输出为可直接导入 CPA 的 JSON 凭证文件。支持一键上传到 CPA 和 sub2api 后端。

## 功能

- **验证码登录** — 自动切换 one-time code 方式，无需密码
- **自动邮箱轮询** — 配置邮件 API 后，自动获取验证码
- **手动输入验证码** — 使用外部邮箱时，弹窗提示输入验证码
- **CPA 一键上传** — 提取后直接上传到你的 CPA 后端，支持自动上传
- **sub2api 一键上传** — 提取后直接上传到你的 sub2api 实例，支持自动上传
- **复制 RT** — 一键复制 refresh_token，给 sub2api 等工具使用
- **凭证管理** — 下载、上传、删除，操作完即删不留痕迹
- **代理支持** — 服务器 IP 被 OpenAI 限制时可配置代理
- **反爬检测绕过** — Puppeteer-extra + Stealth 插件
- **WebSocket 实时日志** — 浏览器端实时查看提取进度

## 快速开始

### 环境要求

- Node.js >= 18
- Chromium（Puppeteer 自动安装）

### 安装

```bash
git clone https://github.com/lytxsy/gpt-token-extractor.git
cd gpt-token-extractor
npm install
```

### 配置

复制 `.env.example` 为 `.env`，填入你的配置：

```bash
cp .env.example .env
```

编辑 `.env`：

```env
PORT=8090
MAIL_API_BASE=https://your-mail-api.example.com
MAIL_ADMIN_KEY=your-admin-key
OAUTH_CLIENT_ID=app_EMoamEEZ73f0CkXaXp7hrann
OAUTH_REDIRECT_PORT=1455
ADMIN_PASSWORD=
AUTO_MAIL_DOMAINS=example.com,your-domain.xyz
PROXY=
```

| 配置项 | 说明 |
|--------|------|
| `PORT` | Web 服务端口 |
| `MAIL_API_BASE` | 邮箱 API 地址（用于自动获取验证码） |
| `MAIL_ADMIN_KEY` | 邮箱 API 管理密钥 |
| `OAUTH_CLIENT_ID` | OpenAI OAuth Client ID，默认值 `app_EMoamEEZ73f0CkXaXp7hrann` |
| `OAUTH_REDIRECT_PORT` | OAuth 回调端口 |
| `ADMIN_PASSWORD` | 管理密码，留空则不启用登录验证 |
| `AUTO_MAIL_DOMAINS` | 自动获取验证码的邮箱域名，逗号分隔 |
| `PROXY` | HTTP/SOCKS5 代理地址，留空不使用 |

### 启动

```bash
node server.js
```

打开浏览器访问 `http://localhost:8090`。

### Docker 部署

```bash
docker compose up -d
```

生产环境建议通过 Nginx 反代并配置 HTTPS。

## 使用说明

1. 打开 Web 界面
2. 输入 OpenAI 账号邮箱
3. 点击「开始提取」
4. 等待自动登录完成
5. 下载 JSON 凭证或一键上传到 CPA

### 关于验证码

- 配置了 `AUTO_MAIL_DOMAINS` 和邮件 API 的邮箱，系统会自动轮询获取验证码
- 使用外部邮箱时，系统会弹出输入框让你手动输入验证码

### 关于代理

如果授权码换取 Token 阶段失败（403），说明服务器 IP 被 OpenAI 限制，在 `.env` 中配置代理即可：

```env
PROXY=http://127.0.0.1:7890
# 或
PROXY=socks5://127.0.0.1:7890
```

### CPA 上传配置

在页面底部的「CPA 上传配置」中填入：
- **CPA 后端地址** — 你的 CPA 实例地址
- **Management Key** — CPA 管理密钥（不需要 Bearer 前缀）
- **提取后自动上传** — 勾选后每次提取完成自动上传到 CPA

### sub2api 上传配置

在页面底部的「sub2api 上传配置」中填入：
- **sub2api 地址** — 你的 sub2api 实例地址（如 `http://127.0.0.1:8080`）
- **认证方式** — 可选择管理员邮箱/密码，或 Admin API Key
- **管理员邮箱 / 管理员密码** — 使用 sub2api 管理员账号登录后创建账号（原有方式）
- **Admin API Key** — 使用 sub2api 后台生成的管理员 API Key，通过 `x-api-key` 请求头创建账号
- **提取后自动上传** — 勾选后每次提取完成自动上传到 sub2api

使用 Admin API Key 时，需要先在 sub2api 后台「设置」中生成管理员 API Key。上传时工具会调用 `POST /api/v1/admin/accounts`，用提取到的 `refresh_token` 自动创建 OpenAI OAuth 账号，并在页面日志中回显创建出的账号 ID、状态和认证方式。

## 输出格式

凭证文件命名格式：`codex-{邮箱}-plus.json`

```json
{
  "access_token": "eyJ...",
  "account_id": "xxxxxxxx",
  "disabled": false,
  "email": "user@example.com",
  "expired": "2026-05-30T12:00:00+08:00",
  "id_token": "eyJ...",
  "last_refresh": "2026-04-30T12:00:00+08:00",
  "refresh_token": "...",
  "type": "codex"
}
```

可直接导入到支持该格式的 CLI Proxy API 工具。

## 技术栈

- **后端**: Node.js + Express + WebSocket (ws)
- **浏览器自动化**: Puppeteer-extra + Stealth Plugin
- **OAuth**: PKCE 流程 (code_challenge + code_verifier)

## License

MIT
