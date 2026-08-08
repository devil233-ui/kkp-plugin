const LOOPBACK_HOSTS = new Set([ "127.0.0.1", "[::1]", "::1", "localhost" ]);

export function validateUgoiraApiUrl(apiUrl) {
    const parsedUrl = new URL(apiUrl);
    const isLoopbackHttp = parsedUrl.protocol === "http:" && LOOPBACK_HOSTS.has(parsedUrl.hostname);

    if (parsedUrl.protocol !== "https:" && !isLoopbackHttp) {
        throw new Error("Ugoira服务仅允许HTTPS或回环地址HTTP");
    }

    return parsedUrl.toString();
}
