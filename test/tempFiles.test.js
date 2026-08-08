import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cleanupExpiredTempDirs } from "../apps/tempFiles.js";

test("TTL清理只删除匹配前缀的过期临时目录", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "kkp-temp-test-"));
    const oldDir = path.join(rootDir, "kkp-pixiv-old");
    const freshDir = path.join(rootDir, "kkp-pixiv-fresh");
    const unrelatedDir = path.join(rootDir, "other-old");

    try {
        fs.mkdirSync(oldDir);
        fs.mkdirSync(freshDir);
        fs.mkdirSync(unrelatedDir);
        const oldDate = new Date(Date.now() - 10_000);
        fs.utimesSync(oldDir, oldDate, oldDate);
        fs.utimesSync(unrelatedDir, oldDate, oldDate);

        cleanupExpiredTempDirs("kkp-pixiv-", 1_000, rootDir);

        assert.equal(fs.existsSync(oldDir), false);
        assert.equal(fs.existsSync(freshDir), true);
        assert.equal(fs.existsSync(unrelatedDir), true);
    } finally {
        fs.rmSync(rootDir, { recursive: true, force: true });
    }
});
