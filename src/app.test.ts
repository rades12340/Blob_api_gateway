import { afterEach, expect, test } from "bun:test";
import { type GatewayOptions, startGateway } from "./app";
import { createLogger } from "./log";

const servers: { stop: (force?: boolean) => unknown }[] = [];

afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
});

// Stands in for a service: echoes what it received, and sends cookies and a
// CORS header of its own so we can check what the gateway does with them.
function startEcho(name: string) {
    const server = Bun.serve({
        port: 0,
        async fetch(request) {
            const url = new URL(request.url);
            const headers = new Headers({
                "Access-Control-Allow-Origin": "*",
                "X-Upstream": name,
            });
            headers.append("Set-Cookie", "a=1; Path=/; HttpOnly");
            headers.append("Set-Cookie", "b=2; Path=/");
            return Response.json(
                {
                    name,
                    method: request.method,
                    path: url.pathname,
                    search: url.search,
                    headers: Object.fromEntries(request.headers),
                    body: await request.text(),
                },
                { status: url.pathname === "/created" ? 201 : 200, headers },
            );
        },
    });
    servers.push(server);
    return `http://127.0.0.1:${server.port}`;
}

function setup(options: GatewayOptions = {}, level = "info") {
    const raw: string[] = [];
    // Request lines only; the startup "listening" line is left out.
    const logs: Record<string, unknown>[] = [];
    const log = createLogger({
        service: "api_gateway",
        level,
        write: (line) => {
            raw.push(line);
            const parsed = JSON.parse(line);
            if (parsed.message !== "listening") logs.push(parsed);
        },
    });
    const gateway = startGateway({
        port: 0,
        upstreams: {
            "/api/auth": startEcho("auth"),
            "/api/blob": startEcho("blob"),
        },
        corsOrigin: "http://app.test",
        rateLimit: { limit: 100, windowMs: 60_000 },
        log,
        ...options,
    });
    servers.push(gateway);
    return { base: `http://127.0.0.1:${gateway.port}`, logs, raw };
}

test("routes by prefix and strips it, keeping the query", async () => {
    const { base } = setup();

    const auth = await (await fetch(`${base}/api/auth/me?x=1`)).json();
    expect(auth.name).toBe("auth");
    expect(auth.path).toBe("/me");
    expect(auth.search).toBe("?x=1");

    const blob = await (await fetch(`${base}/api/blob/download/abc`)).json();
    expect(blob.name).toBe("blob");
    expect(blob.path).toBe("/download/abc");

    const root = await (await fetch(`${base}/api/blob`)).json();
    expect(root.path).toBe("/");
});

test("doesn't match a prefix that is only part of a segment", async () => {
    const { base } = setup();
    expect((await fetch(`${base}/api/authx/me`)).status).toBe(404);
    expect((await fetch(`${base}/nowhere`)).status).toBe(404);
});

test("forwards method, body, auth and cookies, and adds forwarding headers", async () => {
    const { base } = setup();

    const response = await fetch(`${base}/api/auth/created`, {
        method: "POST",
        headers: {
            Authorization: "Bearer token-1",
            Cookie: "refresh_token=abc",
            "Content-Type": "application/json",
            "X-Forwarded-For": "1.2.3.4",
            "X-Request-Id": "req-1",
        },
        body: JSON.stringify({ email: "me@example.com" }),
    });

    expect(response.status).toBe(201);
    const echo = await response.json();
    expect(echo.method).toBe("POST");
    expect(echo.body).toBe('{"email":"me@example.com"}');
    expect(echo.headers.authorization).toBe("Bearer token-1");
    expect(echo.headers.cookie).toBe("refresh_token=abc");
    expect(echo.headers["content-type"]).toBe("application/json");
    // The client's own entry is kept, the real address is appended last.
    expect(echo.headers["x-forwarded-for"]).toMatch(/^1\.2\.3\.4, \S+$/);
    expect(echo.headers["x-forwarded-proto"]).toBe("http");
    expect(echo.headers["x-request-id"]).toBe("req-1");
    expect(response.headers.get("x-request-id")).toBe("req-1");
});

test("streams multipart uploads through unchanged", async () => {
    const { base } = setup();
    const form = new FormData();
    form.set("file", new Blob(["hello upload"]), "a.txt");

    const echo = await (
        await fetch(`${base}/api/blob/upload`, { method: "POST", body: form })
    ).json();
    expect(echo.headers["content-type"]).toStartWith("multipart/form-data");
    expect(echo.body).toContain("hello upload");
    expect(echo.body).toContain('filename="a.txt"');
});

test("passes every Set-Cookie back and replaces the service's CORS headers", async () => {
    const { base } = setup();

    const response = await fetch(`${base}/api/auth/login`, { method: "POST" });
    expect(response.headers.getSetCookie()).toEqual([
        "a=1; Path=/; HttpOnly",
        "b=2; Path=/",
    ]);
    expect(response.headers.get("x-upstream")).toBe("auth");
    expect(response.headers.get("access-control-allow-origin")).toBe(
        "http://app.test",
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe(
        "true",
    );
});

test("answers preflights itself", async () => {
    const { base, logs } = setup();

    const response = await fetch(`${base}/api/blob/upload`, {
        method: "OPTIONS",
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
        "http://app.test",
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
        "Authorization",
    );
    expect(response.headers.get("x-upstream")).toBeNull();
    expect(logs.at(-1)).toMatchObject({ method: "OPTIONS", status: 204 });
});

test("returns 502 when a service is down", async () => {
    const { base, logs } = setup({
        upstreams: { "/api/auth": "http://127.0.0.1:1" },
    });

    const response = await fetch(`${base}/api/auth/me`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Upstream unavailable" });
    const failed = logs.find(
        (line) => line.message === "upstream request failed",
    );
    expect(failed).toMatchObject({
        level: "error",
        upstream: "auth",
        requestId: response.headers.get("x-request-id"),
    });
    expect(typeof failed?.error).toBe("string");
    expect(logs.at(-1)).toMatchObject({ message: "request", status: 502 });
});

test("rate limits per client", async () => {
    const { base, logs } = setup({
        rateLimit: { limit: 2, windowMs: 60_000 },
    });

    expect((await fetch(`${base}/api/auth/me`)).status).toBe(200);
    expect((await fetch(`${base}/api/auth/me`)).status).toBe(200);
    const limited = await fetch(`${base}/api/auth/me`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("x-request-id")).toBeTruthy();
    const warning = logs.find((line) => line.message === "rate limited");
    expect(warning).toMatchObject({
        level: "warn",
        service: "api_gateway",
        requestId: limited.headers.get("x-request-id"),
    });
    expect(typeof warning?.clientIp).toBe("string");
    // Health checks aren't counted.
    expect((await fetch(`${base}/health`)).status).toBe(200);
});

test("logs one access line per request, without the query string", async () => {
    const { base, logs } = setup();
    const response = await fetch(`${base}/api/blob/files?token=secret-q`);

    expect(logs).toHaveLength(1);
    const line = logs[0] ?? {};
    expect(line).toMatchObject({
        level: "info",
        service: "api_gateway",
        message: "request",
        method: "GET",
        path: "/api/blob/files",
        status: 200,
        upstream: "blob",
        requestId: response.headers.get("x-request-id"),
    });
    expect(Number.isInteger(line.ms)).toBe(true);
    expect(typeof line.clientIp).toBe("string");
    expect(new Date(String(line.time)).toISOString()).toBe(String(line.time));
    expect(JSON.stringify(line)).not.toContain("secret-q");
});

test("access line has no upstream for unrouted paths, and 404 gets a request id", async () => {
    const { base, logs } = setup();
    const response = await fetch(`${base}/nowhere`);

    expect(response.status).toBe(404);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(logs[0]).toMatchObject({ path: "/nowhere", status: 404 });
    expect(logs[0]).not.toHaveProperty("upstream");
});

test("generates a request id when none is sent, and forwards it upstream", async () => {
    const { base, logs } = setup();
    const response = await fetch(`${base}/api/auth/me`);
    const id = response.headers.get("x-request-id");

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await response.json()).headers["x-request-id"]).toBe(id);
    expect(logs[0]?.requestId).toBe(id);
});

test("replaces an invalid request id", async () => {
    const { base, logs } = setup();
    for (const bad of ["has spaces in it", "a".repeat(500)]) {
        const response = await fetch(`${base}/api/auth/me`, {
            headers: { "X-Request-Id": bad },
        });
        const id = response.headers.get("x-request-id");
        expect(id).not.toBe(bad);
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
        expect((await response.json()).headers["x-request-id"]).toBe(id);
        expect(logs.at(-1)?.requestId).toBe(id);
    }
});

test("never logs the Authorization header or cookies", async () => {
    const { base, raw } = setup({
        upstreams: { "/api/auth": "http://127.0.0.1:1" },
    });
    await fetch(`${base}/api/auth/refresh?code=query-secret`, {
        method: "POST",
        headers: {
            Authorization: "Bearer secret-access-token",
            Cookie: "refresh_token=secret-cookie-value",
        },
    });

    expect(raw.length).toBeGreaterThan(1);
    for (const line of raw) {
        expect(line).not.toContain("secret-access-token");
        expect(line).not.toContain("secret-cookie-value");
        expect(line).not.toContain("query-secret");
    }
});

test("LOG_LEVEL drops lower levels", async () => {
    const { base, logs } = setup(
        {
            upstreams: { "/api/auth": "http://127.0.0.1:1" },
            rateLimit: { limit: 1, windowMs: 60_000 },
        },
        "error",
    );
    await fetch(`${base}/api/auth/me`);
    await fetch(`${base}/api/auth/me`);

    expect(logs.map((line) => line.message)).toEqual([
        "upstream request failed",
    ]);
});

test("createLogger treats an unknown level as info and writes one JSON line per call", () => {
    const lines: string[] = [];
    const log = createLogger({
        service: "test",
        level: "bogus",
        write: (line) => lines.push(line),
    });
    log.debug("hidden");
    log.info("shown", { requestId: "r1" });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
        level: "info",
        service: "test",
        message: "shown",
        requestId: "r1",
    });
});

test("with trustProxy, rate limits by the last X-Forwarded-For entry and forwards the chain unchanged", async () => {
    const { base } = setup({
        rateLimit: { limit: 1, windowMs: 60_000 },
        trustProxy: true,
    });
    const get = (forwardedFor: string) =>
        fetch(`${base}/api/auth/me`, {
            headers: { "X-Forwarded-For": forwardedFor },
        });

    const first = await get("10.0.0.1");
    expect(first.status).toBe(200);
    expect((await first.json()).headers["x-forwarded-for"]).toBe("10.0.0.1");
    expect((await get("10.0.0.2")).status).toBe(200);
    // A spoofed first entry doesn't give 10.0.0.1 a fresh budget.
    expect((await get("1.2.3.4, 10.0.0.1")).status).toBe(429);
});

test("without trustProxy, X-Forwarded-For doesn't change the rate limit key", async () => {
    const { base } = setup({ rateLimit: { limit: 1, windowMs: 60_000 } });
    const get = (forwardedFor: string) =>
        fetch(`${base}/api/auth/me`, {
            headers: { "X-Forwarded-For": forwardedFor },
        });

    expect((await get("10.0.0.1")).status).toBe(200);
    expect((await get("10.0.0.2")).status).toBe(429);
});
