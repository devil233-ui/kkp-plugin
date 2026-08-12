export const PIXIV_INPUT_RULE = "#?pid\\s*(\\d+)|pixiv\\.net\\/(?:\\w+\\/)?(?:artworks|i)\\/(\\d+)";

export function extractPixivId(message) {
    const pidMatch = message.match(/#?pid\s*(\d+)/i);
    const urlMatch = message.match(/pixiv\.net\/(?:\w+\/)?(?:artworks|i)\/(\d+)/i);

    return pidMatch?.[1] || urlMatch?.[1] || null;
}
