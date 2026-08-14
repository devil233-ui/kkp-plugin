import test from "node:test";
import assert from "node:assert/strict";

import {
    DEFAULT_MAX_IMAGE_SIZE_MB,
    isRichMediaTransferFailure,
    resolveMaxImageSize
} from "../apps/pixivSendPolicy.js";

test("图片直发上限默认20MiB并支持配置覆盖", () => {
    assert.deepEqual(resolveMaxImageSize(), {
        megabytes: DEFAULT_MAX_IMAGE_SIZE_MB,
        bytes: 20 * 1024 * 1024
    });
    assert.deepEqual(resolveMaxImageSize({ max_image_size_mb: "32.5" }), {
        megabytes: 32.5,
        bytes: Math.floor(32.5 * 1024 * 1024)
    });
});

test("非法图片直发上限回退到默认值", () => {
    for (const value of [ 0, -1, "invalid", Infinity ]) {
        assert.equal(resolveMaxImageSize({ max_image_size_mb: value }).megabytes, 20);
    }
});

test("识别NapCat富媒体发送失败", () => {
    assert.equal(isRichMediaTransferFailure({ retcode: 1200 }), true);
    assert.equal(isRichMediaTransferFailure({ error: { retcode: "1200" } }), true);
    assert.equal(isRichMediaTransferFailure(new Error("rich media transfer failed")), true);
    assert.equal(isRichMediaTransferFailure({ response: { data: { wording: "Rich Media Transfer Failed" } } }), true);
});

test("普通网络失败不误判为富媒体失败", () => {
    assert.equal(isRichMediaTransferFailure(new Error("Request timeout")), false);
    assert.equal(isRichMediaTransferFailure({ retcode: 1400, message: "bad request" }), false);
});
