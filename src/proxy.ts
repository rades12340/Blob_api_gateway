import type { Logger } from "./log";
import { createRateLimiter } from "./rateLimit";

export type GatewayConfig = {
    // Path prefix -> upstream base URL, e.g. { "/api/auth": "http://auth:4000" }.
    upstreams: Record<string, string>;
    // The browser frontend allowed to call the API with cookies.
    corsOrigin: string;
    rateLimit: { limit: number; windowMs: number };
    // Only behind a proxy that appends X-Forwarded-For, such as blob_frontend.
    trustProxy: boolean;
    log: Logger;
};

// Headers that describe a single connection, not the request, so they must
// not be passed on (RFC 9110 §7.6.1). Host is set by fetch for the upstream.
const HOP_BY_HOP = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
];

// Ids we accept from the client; anything else is replaced, so log lines and
// upstream headers can't carry arbitrary text.
const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function createGateway(config: GatewayConfig) {
    const allow = createRateLimiter(config.rateLimit);
    // Longest prefix first, so "/api/auth/x" never matches a shorter "/api".
    const upstreams = Object.entries(config.upstreams).sort(
        ([a], [b]) => b.length - a.length,
    );

    // The gateway is the only address the browser talks to, so CORS lives
    // here and whatever the services send is replaced.
    const corsHeaders = {
        "Access-Control-Allow-Origin": config.corsOrigin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods":
            "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
    };

    function json(body: unknown, status: number) {
        return Response.json(body, { status });
    }

    function findUpstream(pathname: string) {
        for (const [prefix, target] of upstreams) {
            if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
                return {
                    // "/api/auth" -> "auth", the name used in log lines.
                    name: prefix.split("/").at(-1) || prefix,
                    target,
                    path: pathname.slice(prefix.length) || "/",
                };
            }
        }
        return null;
    }

    async function forward(
        request: Request,
        target: string,
        path: string,
        forwardedFor: string,
        requestId: string,
    ) {
        const url = new URL(request.url);
        const headers = new Headers(request.headers);
        for (const name of HOP_BY_HOP) headers.delete(name);
        headers.set("X-Forwarded-For", forwardedFor);
        headers.set("X-Forwarded-Host", url.host);
        headers.set("X-Forwarded-Proto", url.protocol.slice(0, -1));
        headers.set("X-Request-Id", requestId);

        const hasBody = request.method !== "GET" && request.method !== "HEAD";
        const upstream = await fetch(`${target}${path}${url.search}`, {
            method: request.method,
            headers,
            // Streamed, so a 25 MB upload isn't buffered in the gateway.
            body: hasBody ? request.body : undefined,
            redirect: "manual",
            // Pass compressed bodies through as-is, with their headers.
            decompress: false,
        });

        const responseHeaders = new Headers(upstream.headers);
        for (const name of HOP_BY_HOP) responseHeaders.delete(name);
        for (const name of [...responseHeaders.keys()]) {
            if (name.startsWith("access-control-")) {
                responseHeaders.delete(name);
            }
        }
        return new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: responseHeaders,
        });
    }

    async function route(
        request: Request,
        pathname: string,
        match: ReturnType<typeof findUpstream>,
        clientIp: string,
        forwardedFor: string,
        requestId: string,
    ): Promise<Response> {
        if (pathname === "/health") return json({ status: "ok" }, 200);

        if (!match) return json({ error: "Not found" }, 404);

        // Preflights are answered here and never reach the services.
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204 });
        }

        if (!allow(clientIp)) {
            config.log.warn("rate limited", { requestId, clientIp });
            return json({ error: "Too many requests" }, 429);
        }

        try {
            return await forward(
                request,
                match.target,
                match.path,
                forwardedFor,
                requestId,
            );
        } catch (error) {
            config.log.error("upstream request failed", {
                requestId,
                upstream: match.name,
                error: String(error),
            });
            return json({ error: "Upstream unavailable" }, 502);
        }
    }

    return async function handle(
        request: Request,
        server: Bun.Server<unknown>,
    ): Promise<Response> {
        const started = performance.now();
        const socketIp = server.requestIP(request)?.address ?? "unknown";
        const incoming = request.headers.get("x-forwarded-for");
        // Behind blob_frontend's server, every request comes from that server.
        // With trustProxy, the client is the last entry it appended, and the
        // chain goes on unchanged. Otherwise the socket address is the client
        // and is appended. Either way the last entry is the real client, which
        // is the one services that trust the gateway (auth_service) read.
        const trusted = config.trustProxy
            ? incoming?.split(",").at(-1)?.trim()
            : undefined;
        const clientIp = trusted || socketIp;
        const forwardedFor = trusted
            ? (incoming as string)
            : incoming
              ? `${incoming}, ${socketIp}`
              : socketIp;
        const incomingId = request.headers.get("x-request-id");
        const requestId =
            incomingId && REQUEST_ID.test(incomingId)
                ? incomingId
                : crypto.randomUUID();
        // Only the path is logged: query strings can carry tokens.
        const { pathname } = new URL(request.url);
        const match = pathname === "/health" ? null : findUpstream(pathname);

        const response = await route(
            request,
            pathname,
            match,
            clientIp,
            forwardedFor,
            requestId,
        );
        for (const [name, value] of Object.entries(corsHeaders)) {
            response.headers.set(name, value);
        }
        response.headers.set("X-Request-Id", requestId);

        config.log.info("request", {
            requestId,
            method: request.method,
            path: pathname,
            status: response.status,
            ms: Math.round(performance.now() - started),
            upstream: match?.name,
            clientIp,
        });
        return response;
    };
}
