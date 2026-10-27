# kkp-plugin维护说明

- 云崽会先匹配插件的`rule.reg`，匹配成功后才调用处理函数；修改命令参数格式时必须同步检查入口规则与函数内部解析逻辑。
- 修改后至少运行`npm test`、相关文件的`node --check`与`npx eslint`，并从`/root/Yunzai`动态导入`./plugins/kkp-plugin/index.js`确认入口能加载真实插件类。独立Node进程没有云崽注入的全局对象，加载前需提供最小`logger`和`segment`测试桩；否则会在入口日志处误报`logger is not defined`。
- `config/`是本机配置目录且已忽略，不应提交Token或机器专用地址。
- **Pixiv RefreshToken刷新（2026-10-26实测）**：`getToken/pixiv_login.js`三命令`login/exchange '<callback URL>'/verify`；PKCE状态文件`/tmp/pixiv_pkce_state.json`（0600，600秒TTL，exchange时校验code_challenge配对——code与verifier错配报918 invalid_request，token真失效报1508）。本机总控入口`pixiv_token.ps1 -Target server`（Windows侧D:\OneDrive\Portable\小工具\获取各平台ck、token脚本\获取Pixiv Token\）自动完成抓码→写入token.yaml→`pm2 restart yz`；`-Status`只读验证。
- **抓code必须在CDP Network层**：pixiv登录成功后302到`pixiv://account/login?code=...`深链，浏览器无法导航、tab URL不变、历史不记录——轮询tab URL或Edge历史永远抓不到；正确做法是CDP `Network.enable`监听`Network.requestWillBeSent`/`responseReceived`里的重定向链（本机脚本`pixiv_cdp_watch.py`，独立Edge profile `%TEMP%\pixiv-edge-cdp`，端口9222）。本机请求走socks5h://127.0.0.1:10808（oauth.secure.pixiv.net无代理直连会失败；`requests`需pysocks）。
- **刷新token不重启也能生效**：apps/pixivAuth.js热加载config/token.yaml；但`pm2 restart yz`最干净（`pixiv_token.ps1`已自动重启）。

## p站ck 指令（apps/PixivTokenCmd.js）

Yunzai 的 `#` 前缀可省略，对外文案与文档一律不带 `#`，避免误以为强制。

| 指令 | 权限 | 作用 |
|---|---|---|
| `p站ck` | master | 实测刷新当前 RefreshToken，回 ALIVE/DEAD |
| `p站ck刷新` | master | 生成登录链接发群，登记 10 分钟刷新会话 |
| `p站码 <回跳链接>` | master | 用回跳链接里的 code 换新 token 并写入 config/token.yaml（热加载，无需重启） |

- 底层全部走 `getToken/pixiv_login.js`（login/exchange/verify），不在群里暴露账号名与 token（sanitize 抹除）。
- Windows 用户本机刷新走 `getToken/refresh.js` 统一入口（独立 Edge CDP 9223 + Network 层抓 pixiv:// 深链）；服务器直接用上面三条指令。
- 报错文案见 apps/pixivAuth.js：token 失效提示已改指 p站ck刷新 指令。
