# Pixiv Token 刷新（getToken）

kkp 插件的 Pixiv RefreshToken 失效后（群里推送「Pixiv RefreshToken已失效或被拒绝」），用本目录工具重新获取并写入 `../config/token.yaml`。

目录里有两条路线，按你的环境选；不想判断就直接跑统一入口 `refresh.js`（推荐，它会自动分流）。

## 统一入口（推荐）

```sh
node refresh.js
```

自动检测环境并分流：

| 检测结果 | 走的路线 | 说明 |
|---|---|---|
| Windows（本机装云崽） | 本机路线 | 打开系统默认浏览器登录，抓码后本机换 token |
| Linux（服务器装云崽） | 服务器路线 | 登录链接复制到**任意有浏览器的电脑**打开，回来粘贴 code 换 token |

`config/token.yaml` 更新后 kkp 会热加载，一般无需重启 Yunzai。

### 服务器路线时序要求（重要）

`code` 的有效期极短（约几十秒），第 3 步粘贴要**快**：

1. 服务器跑 `node refresh.js`，得到登录链接；
2. 在你自己电脑的浏览器打开链接、登录 Pixiv；
3. 登录成功后浏览器跳到一个打不开的空白/错误页——**这是正常的**（pixiv 会跳 `pixiv://` 深链，桌面浏览器无法处理），此时**立刻**从地址栏复制完整 URL，回到服务器粘贴给 `refresh.js`。

> 提示：地址栏抓不到时，可在登录前按 F12 → Network → 勾选 Preserve log，过滤 `callback`，从请求 URL 里取 `code=` 参数。code 与 PKCE 配对（10 分钟内有效），错配会报 918，token 真失效报 1508。

### 本机路线

`refresh.js` 打开浏览器登录后自动抓取 code（读取 Chromium 内核浏览器的本地数据），全程无需手动粘贴。需要能直连或经代理访问 `oauth.secure.pixiv.net`（国内环境走 `127.0.0.1:10808` socks 代理，无代理直连会失败）。

## 手动路线（refresh.js 分流失败时用）

- **服务器**：`node pixiv_login.js login` → 浏览器登录 → `node pixiv_login.js exchange '<复制的URL>'`，自动备份并写入 token.yaml 后复验；`node pixiv_login.js verify` 随时查 token 死活。
- **本机（Python）**：`python pixiv_auth.py login` → 按 README 顶部老流程 F12 抓 code 粘回 → 手动把打印出的 `refresh_token` 替换进 `../config/token.yaml` 的 `RefreshToken` 行。国内环境先装 socks 支持：`pip install pysocks` 并设 `ALL_PROXY=socks5h://127.0.0.1:10808`。

## 常见问题

- **918 invalid_request**：code 与 PKCE verifier 错配或 code 已被使用——重跑 `node refresh.js`。
- **1508 / invalid_grant**：RefreshToken 已失效（改 Pixiv 密码会吊销所有已发 token），重跑刷新流程。
- **exchange 报找不到 PKCE 状态文件**：`login` 和 `exchange` 必须在同一台机器上跑（状态文件在系统临时目录，10 分钟过期）。
