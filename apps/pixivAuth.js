import axios from "axios";
import fs from "fs";
import YAML from "yaml";
import crypto from "crypto";

let accessTokenCache = null;
let tokenExpireTime = 0;
const CLIENT_ID = "MOBrBDS8blbauoSck0ZfDbtuzpyT";
const CLIENT_SECRET = "lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj";
const HASH_SECRET = "28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c";
export const PIXIV_REFRESH_TOKEN_INVALID = "PIXIV_REFRESH_TOKEN_INVALID";
const PIXIV_REFRESH_TOKEN_MISSING = "PIXIV_REFRESH_TOKEN_MISSING";

class PixivAuthError extends Error {
    constructor(message, code, options = {}) {
        super(message, options);
        this.name = "PixivAuthError";
        this.code = code;
    }
}

function getOAuthErrorDetail(data) {
    if (typeof data === "string") return data;

    return [
        data?.error,
        data?.error_description,
        data?.message,
        data?.errors?.system?.message
    ].filter(Boolean).join(" ");
}

export function normalizePixivAuthError(error) {
    const status = error?.response?.status;
    const detail = getOAuthErrorDetail(error?.response?.data);
    const normalizedDetail = detail.toLowerCase();
    const tokenRejected = status === 400 || status === 401 ||
        /invalid_grant|invalid refresh|refresh token|authentication failed/.test(normalizedDetail);

    if (tokenRejected) {
        return new PixivAuthError(
            "Pixiv RefreshToken已失效或被拒绝，请运行plugins/kkp-plugin/getToken/pixiv_auth.py重新获取，并替换config/token.yaml中的RefreshToken",
            PIXIV_REFRESH_TOKEN_INVALID,
            { cause: error }
        );
    }

    const statusText = status ? `（HTTP ${status}）` : "";
    const detailText = detail ? `：${detail}` : `：${error?.message || "未知错误"}`;
    return new PixivAuthError(`Pixiv Token刷新失败${statusText}${detailText}`, "PIXIV_AUTH_REQUEST_FAILED", { cause: error });
}

export function isPixivTokenActionRequired(error) {
    return error?.code === PIXIV_REFRESH_TOKEN_INVALID || error?.code === PIXIV_REFRESH_TOKEN_MISSING;
}

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

    if (!refreshToken) {
        throw new PixivAuthError(
            "未配置Pixiv RefreshToken，请在config/token.yaml中填写",
            PIXIV_REFRESH_TOKEN_MISSING
        );
    }

    const clientTime = new Date().toISOString().split(".")[0] + "+00:00";
    const clientHash = crypto.createHash("md5").update(clientTime + HASH_SECRET).digest("hex");

    const params = new URLSearchParams({
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "grant_type": "refresh_token",
        "refresh_token": refreshToken
    });

    let res;
    try {
        res = await axios.post("https://oauth.secure.pixiv.net/auth/token", params.toString(), {
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
    } catch (error) {
        throw normalizePixivAuthError(error);
    }

    if (res.data.has_error) {
        throw normalizePixivAuthError({ response: { status: 400, data: res.data } });
    }

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