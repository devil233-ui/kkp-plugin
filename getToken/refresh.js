#!/usr/bin/env node
// refresh.js — Pixiv RefreshToken 刷新统一入口（按环境自动分流，零第三方依赖）
//
// 用法：
//   node refresh.js           # 自动检测环境：Windows→本机路线，Linux→服务器路线
//   node refresh.js verify    # 只查当前 token 死活（两平台通用）
//
// 分流逻辑：
//   Windows（云崽装在本机、有桌面浏览器）
//     → pixiv_cdp.js：起独立 Edge/Chrome（CDP 9223）打开登录页，点一次「继续使用此账号」，
//       在 Network 层抓 pixiv:// 深链里的 code（tab URL/浏览历史都看不到它），
//       code 换 token 直接走本机网络（国内自动用 127.0.0.1:10808 socks 代理）。
//   Linux（云崽在服务器，多半没有桌面浏览器）
//     → pixiv_login.js login/exchange：打印登录链接，用户在自己电脑浏览器登录后
//       把跳转地址栏的 URL 粘回来，服务器完成换 token + 写 config/token.yaml。
//
// 两条路线最终都调用 pixiv_login.js 的 exchange 逻辑写入 ../config/token.yaml。
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === 'win32';
const CDP_PORT = 9223;
const LOGIN_URL = 'https://app-api.pixiv.net/web/v1/login';
const AUTH_TOKEN_URL = 'https://oauth.secure.pixiv.net/auth/token';
const REDIRECT_URI = 'https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback';
const CLIENT_ID = 'MOBrBDS8blbauoSck0ZfDbtuzpyT';
const CLIENT_SECRET = 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj';
const UA = 'PixivAndroidApp/5.0.234 (Android 11; Pixel 5)';
const PROXY = 'http://127.0.0.1:10808'; // Windows 本机 v2ray 常用混合端口；不通则直连

const log = console.log;
const die = (m) => { console.error('ERROR: ' + m); process.exit(1); };
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const s256 = (s) => b64url(crypto.createHash('sha256').update(s, 'ascii').digest());

// ---------- 公用：POST oauth token ----------
function postToken(params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const tz = -d.getTimezoneOffset() / 60;
    const tzStr = (tz >= 0 ? '+' : '-') + pad(Math.abs(tz)) + ':00';
    const clientTime = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${tzStr}`;
    const clientHash = crypto.createHmac('sha256', CLIENT_SECRET).update(clientTime).digest('hex');
    const headers = {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      'X-Client-Time': clientTime,
      'X-Client-Hash': clientHash,
    };
    const doRequest = (useProxy) => {
      const req = useProxy
        ? {
            host: '127.0.0.1', port: 10808, method: 'POST', path: AUTH_TOKEN_URL,
            headers: { ...headers, Host: 'oauth.secure.pixiv.net' },
          }
        : { ...new URL(AUTH_TOKEN_URL), method: 'POST', headers };
      const r = http.request(req, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve({ http: res.statusCode, json: JSON.parse(data) }); }
          catch { resolve({ http: res.statusCode, raw: data.slice(0, 300) }); }
        });
      });
      r.on('error', (e) => reject(e));
      r.end(body);
    };
    if (!IS_WIN) { doRequest(false); return; }
    // Windows：先试代理，连不上就直连
    doRequest(true);
  });
}

async function verifyRt(rt) {
  const r = await postToken({
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token', include_policy: 'true', refresh_token: rt,
  });
  if (r.json?.response?.access_token) return { alive: true, user: r.json.response.user?.name };
  return { alive: false, detail: r.json?.errors?.system?.message || r.json?.error || `HTTP ${r.http}` };
}

function delegate(args, label) {
  const r = spawnSync(process.execPath, [path.join(HERE, 'pixiv_login.js'), ...args], { stdio: 'inherit' });
  if (r.error) die(`${label} 启动失败: ${r.error.message}`);
  process.exit(r.status ?? 1);
}

// ---------- Windows 本机路线 ----------
async function runLocal() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = s256(verifier);
  const loginUrl = `${LOGIN_URL}?code_challenge=${challenge}&code_challenge_method=S256&client=pixiv-android`;

  // 1) 找 Edge/Chrome
  const candidates = [
    process.env['ProgramFiles(x86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env['ProgramFiles'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env['ProgramFiles'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['ProgramFiles(x86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  const exe = candidates.find((p) => fs.existsSync(p));
  if (!exe) die('找不到 Edge/Chrome，请手动走服务器路线：node pixiv_login.js login');

  // 2) 起独立实例（独立 profile，不干扰日常浏览器；端口 9223 避开常用 9222）
  const profile = path.join(process.env.TEMP || HERE, 'pixiv-refresh-cdp');
  fs.rmSync(profile, { recursive: true, force: true });
  log('[1/4] 启动独立浏览器实例（CDP:' + CDP_PORT + '）……');
  const proc = spawn(exe, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1100,850',
    'about:blank',
  ], { stdio: 'ignore', detached: false });

  // 3) 等 CDP 就绪并开登录页
  const cdpGet = (p) => fetch(`http://127.0.0.1:${CDP_PORT}${p}`).then((r) => r.json());
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try { await cdpGet('/json/version'); ready = true; break; } catch { await new Promise((s) => setTimeout(s, 500)); }
  }
  if (!ready) { proc.kill(); die('CDP 30 秒内未就绪'); }
  await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(loginUrl)}`, { method: 'PUT' })
    .then((r) => r.json()).catch(() => null);
  log('[2/4] 登录页已打开。请在窗口里登录 Pixiv 并点「继续使用此账号」。');

  // 4) CDP 轮询：Network 层抓 pixiv:// 深链或 callback?code
  //    （pixiv:// 不改变 tab URL、不进历史，必须在 Network 事件里抓 302 链）
  const ws = await import('node:ws').catch(() => null); // Node22+ 内置 ws 不存在，走原生实现
  const code = await watchNetwork(challenge).catch((e) => { proc.kill(); die(e.message); });
  proc.kill();
  if (!code) die('120 秒内没抓到 code（未完成登录？）。重跑即可。');
  log(`[3/4] 已抓到 code（${code.slice(0, 8)}…），本机换 token……`);

  const r = await postToken({
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code,
    code_verifier: verifier, grant_type: 'authorization_code',
    include_policy: 'true', redirect_uri: REDIRECT_URI,
  });
  if (!r.json?.response?.refresh_token) {
    die('换 token 失败: ' + (r.json?.errors?.system?.message || r.json?.error || `HTTP ${r.http}`));
  }
  const rt = r.json.response.refresh_token;
  const user = r.json.response.user?.name || '?';
  log(`✅ 换取成功，账号: ${user}`);
  log('');
  log('================ RefreshToken ================');
  log(rt);
  log('==============================================');
  log('');
  log('把它写进 kkp 的 config/token.yaml 的 RefreshToken 行即可（kkp 热加载，无需重启）。');
  log(`文件位置示例：<云崽>/plugins/kkp-plugin/config/token.yaml`);
  const v = await verifyRt(rt);
  log(v.alive ? '✅ 复验通过（ALIVE）' : `⚠️ 复验未通过: ${v.detail}`);
}

// 极简 WebSocket 客户端（只够 CDP 用：文本帧、无分片、无压缩）
function watchNetwork(_challenge) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); resolve(null); }, 120_000);
    let sock;
    const cleanup = () => { clearTimeout(timeout); try { sock?.destroy(); } catch {} };

    fetch(`http://127.0.0.1:${CDP_PORT}/json`).then((r) => r.json()).then(async (tabs) => {
      const tab = tabs.find((t) => t.type === 'page' && /pixiv/.test(t.url)) || tabs.find((t) => t.type === 'page');
      if (!tab) return reject(new Error('找不到 CDP page'));
      const url = new URL(tab.webSocketDebuggerUrl);
      const key = crypto.randomBytes(16).toString('base64');
      const http = await import('node:http');
      const req = http.request({
        host: '127.0.0.1', port: CDP_PORT, path: url.pathname + url.search,
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
        },
      });
      req.on('upgrade', (res, socket) => {
        sock = socket;
        let mid = 0;
        let buf = Buffer.alloc(0);
        const send = (obj) => {
          const data = Buffer.from(JSON.stringify(obj));
          const mask = crypto.randomBytes(4);
          const masked = Buffer.from(data.map((b, i) => b ^ mask[i % 4]));
          let head;
          if (data.length < 126) head = Buffer.from([0x81, 0x80 | data.length]);
          else head = Buffer.concat([Buffer.from([0x81, 0x80 | 126]), Buffer.alloc(2)]);
          head.writeUInt16BE(data.length, 2);
          socket.write(Buffer.concat([head, mask, masked]));
        };
        send({ id: ++mid, method: 'Network.enable' });

        socket.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          while (true) {
            if (buf.length < 2) return;
            let len = buf[1] & 0x7f, off = 2;
            if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
            if (buf.length < off + len) return;
            const payload = buf.subarray(off, off + len).toString('utf8');
            buf = buf.subarray(off + len);
            let msg; try { msg = JSON.parse(payload); } catch { continue; }
            const p = msg.params || {};
            const urls = [];
            if (msg.method === 'Network.requestWillBeSent') {
              urls.push(p.request?.url || '');
              if (p.redirectResponse) urls.push(p.redirectResponse.url || '');
            }
            if (msg.method === 'Network.responseReceived') urls.push(p.response?.url || '');
            for (const u of urls) {
              const m = String(u).match(/[?&]code=([A-Za-z0-9_-]+)/);
              if (m && /pixiv/i.test(u)) {
                cleanup();
                resolve(decodeURIComponent(m[1]));
                return;
              }
            }
          }
        });
      });
      req.on('error', (e) => reject(e));
      req.end();
    }).catch(reject);
  });
}

// ---------- main ----------
const arg = process.argv[2];
if (arg === 'verify') delegate(['verify'], 'pixiv_login.js');
if (arg === 'server') delegate(['login'], 'pixiv_login.js'); // 强制服务器路线

log(`检测环境: ${IS_WIN ? 'Windows（本机路线）' : 'Linux（服务器路线）'}`);
log('');
if (IS_WIN) {
  runLocal().catch((e) => die(e.stack || e.message));
} else {
  log('服务器没有桌面浏览器，走「登录链接 + 粘贴 code」路线：');
  log('');
  delegate(['login'], 'pixiv_login.js');
  log('');
  log('—— 登录完成后回到这里 ——');
  const rl = await import('node:readline');
  const it = rl.createInterface({ input: process.stdin, output: process.stdout });
  it.question('粘贴浏览器地址栏的完整 URL（或纯 code）: ', (answer) => {
    it.close();
    const r = spawnSync(process.execPath, [path.join(HERE, 'pixiv_login.js'), 'exchange', answer.trim()], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  });
}
