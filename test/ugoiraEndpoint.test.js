import test from "node:test";
import assert from "node:assert/strict";

import { validateUgoiraApiUrl } from "../apps/ugoiraEndpoint.js";

test("允许回环HTTP和任意HTTPS的Ugoira地址", () => {
    assert.equal(
        validateUgoiraApiUrl("http://127.0.0.1:3008/ugoira"),
        "http://127.0.0.1:3008/ugoira"
    );
    assert.equal(
        validateUgoiraApiUrl("https://ugoira.example.com/ugoira"),
        "https://ugoira.example.com/ugoira"
    );
});

test("拒绝向公网HTTP地址发送PixivToken", () => {
    assert.throws(
        () => validateUgoiraApiUrl("http://23.95.68.22:3008/ugoira"),
        /仅允许HTTPS或回环地址HTTP/
    );
});
