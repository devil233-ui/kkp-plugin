export const DEFAULT_MAX_IMAGE_SIZE_MB = 20;

const MEBIBYTE = 1024 * 1024;
const ERROR_FIELDS = [ "message", "wording", "errMsg", "stack", "cause", "error", "response", "data" ];

export function resolveMaxImageSize(config = {}) {
    const configured = Number(config.max_image_size_mb);
    const megabytes = Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_MAX_IMAGE_SIZE_MB;

    return {
        megabytes,
        bytes: Math.floor(megabytes * MEBIBYTE)
    };
}

export function isRichMediaTransferFailure(value) {
    const pending = [ value ];
    const seen = new WeakSet();

    while (pending.length > 0) {
        const current = pending.pop();
        if (typeof current === "string") {
            if (/rich media transfer failed/i.test(current)) return true;
            continue;
        }
        if (!current || typeof current !== "object") continue;
        if (seen.has(current)) continue;
        seen.add(current);

        if (Number(current.retcode) === 1200) return true;
        for (const field of ERROR_FIELDS) {
            if (field in current) pending.push(current[field]);
        }
    }

    return false;
}
