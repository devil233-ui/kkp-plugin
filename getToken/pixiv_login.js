#!/usr/bin/env node
// pixiv_login.js — Pixiv PKCE 登录助手（服务器端换取，无第三方依赖）
//
// 流程（code 换 token 全程在服务器完成，登录浏览器放用户本机）：
//   1) node pixiv_login.js login
//        生成 PKCE，verifier 存 /tmp 状态文件(0600,10分钟有效)，打印登录链接；
//        在本机浏览器打开链接并登录 Pixiv。
//   2) 登录成功后浏览器会跳到一个打不开的空白/错误页，
//      地址栏形如 https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback?...&code=...
//      把整个地址复制出来。
//   3) node pixiv_login.js exchange '<粘贴的完整URL或纯code>'
//        校验 → 换 refresh_token → 备份并写入 token.yaml → 复验。
//   node pixiv_login.js verify   # 用 token.yaml 里的 RefreshToken 实测刷新
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const CLIENT_ID = 'MOBrBDS8blbauoSck0ZfDbtuzpyT';
const CLIENT_SECRET = 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj';
const REDIRECT_URI = 'https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback';
const LOGIN_URL = 'https://app-api.pixiv.net/web/v1/login';
const AUTH_TOKEN_URL = 'https://oauth.secure.pixiv.net/auth/token';
const UA = 'PixivAndroidApp/5.0.234 (Android 11; Pixel 5)';
// token.yaml 与状态文件都相对本文件定位，安装在任何机器都能用：
//   <插件根>/config/token.yaml；状态文件放系统临时目录（Windows 是 %TEMP%）
const TOKEN_YAML = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config/token.yaml');
const STATE_FILE = path.join(os.tmpdir(), 'pixiv_pkce_state.json');
const STATE_TTL_MS = 10 * 60 * 1000;

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const s256 = (s) => b64url(crypto.createHash('sha256').update(s, 'ascii').digest());
const log = console.log;
const die = (m) => { console.error('ERROR: ' + m); process.exit(1); };

async function postToken(params) {
  // oauth.secure.pixiv.net 要求 X-Client-Time/X-Client-Hash（缺了会报 918 invalid_request，
  // refresh_token 不带也能过、authorization_code 必须带——2026-10-26 实测）
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const tz = -d.getTimezoneOffset() / 60;
  const tzStr = (tz >= 0 ? '+' : '-') + pad(Math.abs(tz)) + ':00';
  const clientTime =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${tzStr}`;
  const clientHash = crypto.createHmac('sha256', CLIENT_SECRET).update(clientTime).digest('hex');
  const res = await fetch(AUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Client-Time': clientTime,
      'X-Client-Hash': clientHash,
    },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { return { http: res.status, raw: text.slice(0, 300) }; }
  return { http: res.status, json };
}

function readRefreshToken() {
  const raw = fs.readFileSync(TOKEN_YAML, 'utf8');
  const m = raw.match(/^\s*RefreshToken:\s*"?([^"\s]+)"?\s*$/m);
  return m ? m[1].trim() : '';
}

function writeRefreshToken(newRt) {
  const raw = fs.readFileSync(TOKEN_YAML, 'utf8');
  if (!raw.includes('RefreshToken:')) die('token.yaml 里没有 RefreshToken 键，不敢自动写');
  const updated = raw.replace(
    /^(\s*RefreshToken:\s*)"?[^"\s]+"?(\s*)$/m,
    (_a, p1, p2) => `${p1}${newRt}${p2}`
  );
  if (!updated.includes(newRt)) die('替换后内容校验失败，放弃写入');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const bak = `${TOKEN_YAML}.bak-${stamp}`;
  fs.copyFileSync(TOKEN_YAML, bak);
  fs.writeFileSync(TOKEN_YAML, updated);
  log(`已备份旧文件: ${bak}`);
  log(`已写入: ${TOKEN_YAML}`);
}

async function verifyRt(rt) {
  const r = await postToken({
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token', include_policy: 'true', refresh_token: rt,
  });
  if (r.json?.response?.access_token) return { alive: true, user: r.json.response.user?.name };
  return {
    alive: false,
    detail: r.json?.errors?.system?.message || r.json?.error || `HTTP ${r.http} ${r.raw || ''}`.trim(),
  };
}

async function main() {
  const cmd = process.argv[2];

  if (cmd === 'login') {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = s256(verifier);
    const state = { verifier, created: Date.now() };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), os.platform() === 'win32' ? undefined : { mode: 0o600 });
    log('PKCE 已生成，verifier 已存 ' + STATE_FILE + '（10 分钟内有效）');
    log('');
    log('在本机浏览器打开下面链接并登录 Pixiv：');
    log(`${LOGIN_URL}?code_challenge=${challenge}&code_challenge_method=S256&client=pixiv-android`);
    log('');
    log('登录成功后浏览器会跳到打不开的空白/错误页——这是正常的。');
    log('把地址栏完整 URL 复制，然后在服务器上执行：');
    log(`  node ${process.argv[1]} exchange '<复制的URL>'`);
    return;
  }

  if (cmd === 'exchange') {
    const input = (process.argv[3] || '').trim();
    if (!input) die('用法: pixiv_login.js exchange <完整URL或纯code>');
    let code = input;
    const m = input.match(/[?&]code=([^&\s]+)/);
    if (m) code = decodeURIComponent(m[1]);
    if (!/^[A-Za-z0-9_-]+$/.test(code)) die('code 格式不合法');
    log(`code 长度 ${code.length}，前缀 ${code.slice(0, 8)}…，立即换取…`);

    if (!fs.existsSync(STATE_FILE)) die('找不到 PKCE 状态文件，请先重跑 login');
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (Date.now() - state.created > STATE_TTL_MS) {
      fs.unlinkSync(STATE_FILE);
      die('PKCE 状态已过期（>10分钟），请重跑 login');
    }

    const r = await postToken({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code,
      code_verifier: state.verifier, grant_type: 'authorization_code',
      include_policy: 'true', redirect_uri: REDIRECT_URI,
    });
    if (!r.json?.response?.refresh_token) {
      const emsg = r.json?.errors?.system?.message || r.json?.error || `HTTP ${r.http} ${(r.raw || '').slice(0, 200)}`;
      die(`换 token 失败: ${emsg}（code 过期/已用就重跑 login）`);
    }
    const rt = r.json.response.refresh_token;
    const user = r.json.response.user?.name || '?';
    fs.unlinkSync(STATE_FILE);
    log(`✅ 换取成功，账号: ${user}，refresh_token 长度 ${rt.length}，前缀 ${rt.slice(0, 8)}…`);
    writeRefreshToken(rt);
    log('复验新 token…');
    const v = await verifyRt(rt);
    if (v.alive) {
      log('✅ 写入后复验通过（ALIVE）');
      log('token.yaml 会被 kkp 热加载；如未生效可重启 Yunzai（pm2 restart yz 等）');
    } else {
      log(`⚠️ 复验未通过: ${v.detail}`);
      process.exit(2);
    }
    return;
  }

  if (cmd === 'verify') {
    const rt = readRefreshToken();
    if (!rt) die('token.yaml 里读不到 RefreshToken');
    log(`读取 RefreshToken（长度${rt.length}，前缀 ${rt.slice(0, 8)}…），实测刷新…`);
    const v = await verifyRt(rt);
    if (v.alive) log('✅ ALIVE — token 有效' + (v.user ? `，账号: ${v.user}` : ''));
    else { log(`❌ DEAD — ${v.detail}`); process.exit(2); }
    return;
  }

  die('用法: pixiv_login.js login | exchange <URL> | verify');
}

main().catch((e) => die(e.stack || e.message));
