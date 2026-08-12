import test from "node:test";
import assert from "node:assert/strict";

import { extractPixivId, PIXIV_INPUT_RULE } from "../apps/pixivInput.js";

test("PID入口规则兼容无空格和空格写法", () => {
    const rule = new RegExp(PIXIV_INPUT_RULE, "i");

    for (const message of [ "pid148101308", "pid 148101308", "#pid   148101308" ]) {
        assert.equal(rule.test(message), true, message);
        assert.equal(extractPixivId(message), "148101308", message);
    }
});

test("Pixiv作品链接保持可识别", () => {
    const message = "https://www.pixiv.net/artworks/148101308";

    assert.equal(new RegExp(PIXIV_INPUT_RULE, "i").test(message), true);
    assert.equal(extractPixivId(message), "148101308");
});
