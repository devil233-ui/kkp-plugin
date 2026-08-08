import fs from "fs";
import os from "os";
import path from "path";

export const TEMP_DIR_TTL = 6 * 60 * 60 * 1000;

export function createRequestTempDir(prefix, rootDir = os.tmpdir()) {
    return fs.mkdtempSync(path.join(rootDir, prefix));
}

export function cleanupExpiredTempDirs(prefix, maxAge = TEMP_DIR_TTL, rootDir = os.tmpdir()) {
    const now = Date.now();

    try {
        for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;

            const targetPath = path.join(rootDir, entry.name);
            try {
                const stat = fs.statSync(targetPath);
                if (now - stat.mtimeMs > maxAge) {
                    fs.rmSync(targetPath, { recursive: true, force: true });
                }
            } catch (error) {
                globalThis.logger?.debug?.(`[kkp-plugin] 跳过无法检查的临时目录 ${targetPath}：${error.message}`);
            }
        }
    } catch (error) {
        globalThis.logger?.debug?.(`[kkp-plugin] 临时目录TTL清理失败：${error.message}`);
    }
}
