// 本地 Ugoira → GIF 渲染服务（零第三方依赖，替代迷迷 3008 服务）
//
// API 契约与原服务一致：
//   POST /ugoira  { pid, access_token }
//   成功 → { status: "success", data: <base64 gif> }
//   失败 → { error: "..." }（HTTP 4xx/5xx）
//
// 管线：app-api meta → 下载 zip 帧 → 解压 → ffmpeg concat（不均匀帧率）→ palette GIF
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);
const PORT = Number(process.env.UGOIRA_PORT || 3008);
const HOST = "127.0.0.1";
const META_API = "https://app-api.pixiv.net/v1/ugoira/metadata";
const UA = "PixivAndroidApp/5.0.234 (Android 11; Pixel 5)";
const MAX_CONCURRENT = 1; // 2GB 内存机器，渲染串行
let active = 0;

const UGOIRA_UA_HEADERS = {
    "User-Agent": UA,
    "App-OS": "ios",
    "App-OS-Version": "14.6",
    "App-Version": "5.0.234",
    "Accept-Language": "zh-CN"
};

async function fetchMeta(pid, accessToken) {
    const url = `${META_API}?illust_id=${encodeURIComponent(pid)}`;
    const res = await fetch(url, {
        headers: { ...UGOIRA_UA_HEADERS, Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw Object.assign(new Error(`meta ${res.status}: ${text.slice(0, 120)}`), { status: res.status === 404 ? 404 : 502 });
    }
    const j = await res.json();
    if (!j.ugoira_metadata || !j.ugoira_metadata.zip_urls) {
        throw Object.assign(new Error("Ugoira meta not found or R-18 restricted"), { status: 404 });
    }
    return j.ugoira_metadata;
}

async function downloadZip(zipUrl, accessToken) {
    const res = await fetch(zipUrl, {
        headers: { ...UGOIRA_UA_HEADERS, Authorization: `Bearer ${accessToken}`, Referer: "https://app-api.pixiv.net/" },
        signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) throw Object.assign(new Error(`zip ${res.status}`), { status: 502 });
    return Buffer.from(await res.arrayBuffer());
}

async function run(cmd, args, opts) {
    const { stdout, stderr } = await execFileP(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts });
    return { stdout, stderr };
}

// frames: [{file, delay(ms)}]，pixiv 帧表不均匀 → concat demuxer
async function renderGif(workDir, frames, width, fpsCap) {
    const last = frames[frames.length - 1];
    const concat = frames.map(f => `file '${f.file}'\nduration ${(f.delay / 1000).toFixed(3)}`).join("\n")
        + `\nfile '${last.file}'`;
    fs.writeFileSync(path.join(workDir, "list.txt"), concat);
    const outGif = path.join(workDir, `out_${width}_${fpsCap}.gif`);
    // fps_cap 用 minterpolate 太重；直接对 concat 时间轴后处理 fps 滤镜降帧
    const vf = `fps=${fpsCap},scale=${width}:-2:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4`;
    await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-vf", vf, outGif], { cwd: workDir });
    return outGif;
}

async function renderOnce(workDir, frames) {
    const outGif = path.join(workDir, "out.gif");
    const concat = frames.map(f => `file '${f.file}'\nduration ${(f.delay / 1000).toFixed(3)}`).join("\n")
        + `\nfile '${frames[frames.length - 1].file}'`;
    fs.writeFileSync(path.join(workDir, "list.txt"), concat);
    const vf = "scale=540:-2:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4";
    await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-vf", vf, outGif], { cwd: workDir });
    return outGif;
}

async function handleUgoira(body) {
    const pid = String(body.pid || "").replace(/\D/g, "");
    const accessToken = String(body.access_token || "");
    if (!pid || !accessToken) {
        throw Object.assign(new Error("Missing pid or access_token"), { status: 400 });
    }
    const meta = await fetchMeta(pid, accessToken);
    const zipBuf = await downloadZip(meta.zip_urls.medium, accessToken);

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ugoira-"));
    try {
        const zipPath = path.join(workDir, "frames.zip");
        fs.writeFileSync(zipPath, zipBuf);
        await run("unzip", ["-q", "-o", zipPath, "-d", workDir]);
        const frames = meta.frames.map(f => ({ file: f.file, delay: f.delay }));
        // 校验帧文件真的解出来了（防止帧表与zip不一致）
        for (const f of frames) {
            if (!fs.existsSync(path.join(workDir, f.file))) {
                throw Object.assign(new Error(`frame file missing: ${f.file}`), { status: 502 });
            }
        }
        const gifPath = await renderOnce(workDir, frames);
        const size = fs.statSync(gifPath).size;
        const b64 = fs.readFileSync(gifPath).toString("base64");
        return { status: "success", data: b64, meta: { size, frames: frames.length } };
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", active, maxConcurrent: MAX_CONCURRENT }));
        return;
    }
    if (req.method !== "POST" || req.url !== "/ugoira") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
    }
    let body = "";
    req.on("data", c => { body += c; if (body.length > 1024 * 1024) req.destroy(); });
    req.on("end", async () => {
        if (active >= MAX_CONCURRENT) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Renderer busy, try later" }));
            return;
        }
        active++;
        const t0 = Date.now();
        try {
            const parsed = JSON.parse(body || "{}");
            const result = await handleUgoira(parsed);
            console.log(`[ugoira] pid=${parsed.pid} ok ${((Date.now() - t0) / 1000).toFixed(1)}s size=${result.meta.size}`);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
        } catch (e) {
            console.error(`[ugoira] fail ${((Date.now() - t0) / 1000).toFixed(1)}s: ${e.message}`);
            res.writeHead(e.status || 500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
        } finally {
            active--;
        }
    });
});

server.listen(PORT, HOST, () => console.log(`[ugoira] local renderer listening on ${HOST}:${PORT}`));
for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000); });
}
process.on("uncaughtException", e => console.error("[ugoira] uncaught:", e.message));
