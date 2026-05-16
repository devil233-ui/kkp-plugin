import axios from "axios";
import fs from "fs";
import YAML from "yaml";
import crypto from "crypto";

let accessTokenCache = null;
let tokenExpireTime = 0;
const CLIENT_ID = "MOBrBDS8blbauoSck0ZfDbtuzpyT";
const CLIENT_SECRET = "lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj";
const HASH_SECRET = "28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c";

export async function getAppApiHeaders() {
    if (accessTokenCache && Date.now() < tokenExpireTime) {
        return buildHeaders(accessTokenCache);
    }

    const configPath = "./plugins/kkp-plugin/config/token.yaml";
    let refreshToken = "";
    if (fs.existsSync(configPath)) {
        const config = YAML.parse(fs.readFileSync(configPath, "utf8")) || {};
        refreshToken = config.RefreshToken ? String(config.RefreshToken).trim() : "";
    }

    if (!refreshToken) throw new Error("未配置 RefreshToken，请在 config/token.yaml 中填写");

    const clientTime = new Date().toISOString().split(".")[0] + "+00:00";
    const clientHash = crypto.createHash("md5").update(clientTime + HASH_SECRET).digest("hex");

    const params = new URLSearchParams({
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "grant_type": "refresh_token",
        "refresh_token": refreshToken
    });

    const res = await axios.post("https://oauth.secure.pixiv.net/auth/token", params.toString(), {
        headers: {
            "User-Agent": "PixivAndroidApp/5.0.234 (Android 11; Pixel 5)",
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Client-Time": clientTime,
            "X-Client-Hash": clientHash,
            "App-OS": "android",
            "App-OS-Version": "11",
            "App-Version": "5.0.234"
        }
    });

    if (res.data.has_error) throw new Error("Token 刷新被 Pixiv 拒绝");

    accessTokenCache = res.data.response.access_token;
    tokenExpireTime = Date.now() + (res.data.response.expires_in - 300) * 1000;
    
    return buildHeaders(accessTokenCache);
}

function buildHeaders(token) {
    return {
        "Authorization": `Bearer ${token}`,
        "User-Agent": "PixivAndroidApp/5.0.234 (Android 11; Pixel 5)",
        "App-OS": "android",
        "App-OS-Version": "11",
        "App-Version": "5.0.234",
        "Accept-Language": "zh-CN"
    };
}