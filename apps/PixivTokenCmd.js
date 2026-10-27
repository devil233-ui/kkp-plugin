import plugin from "../../../lib/plugins/plugin.js";
import { execFile } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const GET_TOKEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "getToken");
const REFRESH_TTL_MS = 10 * 60 * 1000;

// user_id -> 会话创建时间；只允许 master 自己的下一发「#p站码 …」生效
const refreshSessions = new Map();

function runTool(args, timeout = 60000) {
    return new Promise((resolve) => {
        execFile(
            process.execPath,
            [path.join(GET_TOKEN_DIR, "pixiv_login.js"), ...args],
            { timeout, encoding: "utf8" },
            (err, stdout = "", stderr = "") => resolve({
                ok: !err,
                text: `${stdout}\n${stderr}`.trim()
            })
        );
    });
}

// 脚本输出里的账号名与 token 前缀不回传到群里（群成员可见，属账号隐私）
function sanitize(text) {
    return text
        .replace(/，?账号: ?\S+/g, "")
        .replace(/前缀 [A-Za-z0-9_-]+…/g, "")
        .replace(/，\s*）/g, "）")
        .replace(/，\s*$/gm, "")
        .split("\n").map(l => l.trim()).filter(Boolean).join("\n");
}

export class PixivTokenCmd extends plugin {
    constructor() {
        super({
            name: "P站Token维护",
            dsc: "Pixiv RefreshToken 状态查询与刷新",
            event: "message",
            priority: 50,
            rule: [
                { reg: "^#?p站ck$", fnc: "tokenStatus", permission: "master" },
                { reg: "^#?p站ck刷新$", fnc: "tokenRefresh", permission: "master" },
                { reg: "^#?p站码\\s*(\\S+)", fnc: "tokenSubmit", permission: "master" }
            ]
        });
    }

    // #p站ck —— 查当前 token 死活
    async tokenStatus(e) {
        const r = await runTool(["verify"], 30000);
        const out = sanitize(r.text);
        await e.reply(out || `检查失败：${r.text}`);
        return true;
    }

    // #p站ck刷新 —— 生成登录链接，等 master 回贴回跳地址
    async tokenRefresh(e) {
        const r = await runTool(["login"], 15000);
        const url = (r.text.match(/https:\/\/app-api\.pixiv\.net\/web\/v1\/login\S+/) || [])[0];
        if (!url) {
            await e.reply(`生成登录链接失败：${sanitize(r.text)}`);
            return true;
        }
        refreshSessions.set(e.user_id, Date.now());
        await e.reply([
            "请在浏览器打开下面链接登录 P 站；登录成功后浏览器停在打不开的空白页是正常的：",
            url,
            "",
            `然后把地址栏的完整链接发给我：#p站码 链接（${REFRESH_TTL_MS / 60000} 分钟内有效）`
        ].join("\n"));
        return true;
    }

    // #p站码 <回跳链接或纯code> —— 换取并写入 token.yaml（热加载，无需重启）
    async tokenSubmit(e) {
        const input = e.msg.replace(/^#?p站码\s*/, "").trim();
        const created = refreshSessions.get(e.user_id);
        if (!created) {
            if (input.includes("code=")) {
                await e.reply("当前没有进行中的刷新，请先发 #p站ck刷新");
                return true;
            }
            return false;
        }
        if (Date.now() - created > REFRESH_TTL_MS) {
            refreshSessions.delete(e.user_id);
            await e.reply("刷新会话已超时（超过10分钟），请重新发 #p站ck刷新");
            return true;
        }
        refreshSessions.delete(e.user_id);
        const r = await runTool(["exchange", input], 60000);
        const out = sanitize(r.text);
        await e.reply(out || `换取失败：${r.text}`);
        return true;
    }
}
