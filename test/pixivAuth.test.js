import test from "node:test";
import assert from "node:assert/strict";
import {
    PIXIV_REFRESH_TOKEN_INVALID,
    isPixivTokenActionRequired,
    normalizePixivAuthError
} from "../apps/pixivAuth.js";

test("OAuth 400会识别为RefreshToken失效", () => {
    const error = normalizePixivAuthError({
        message: "Request failed with status code 400",
        response: { status: 400, data: { error: "invalid_grant" } }
    });

    assert.equal(error.code, PIXIV_REFRESH_TOKEN_INVALID);
    assert.equal(isPixivTokenActionRequired(error), true);
    assert.match(error.message, /重新获取.*替换/);
});

test("Pixiv服务端错误不会误报为RefreshToken失效", () => {
    const error = normalizePixivAuthError({
        message: "Request failed with status code 503",
        response: { status: 503, data: { message: "Service Unavailable" } }
    });

    assert.equal(error.code, "PIXIV_AUTH_REQUEST_FAILED");
    assert.equal(isPixivTokenActionRequired(error), false);
    assert.match(error.message, /HTTP 503/);
});
