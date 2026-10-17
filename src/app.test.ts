import { afterEach, expect, test } from "bun:test";
import { type GatewayOptions, startGateway } from "./app";

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

function setup(options: GatewayOptions = {}) {
    const logs: Record<string, unknown>[] = [];
    const gateway = startGateway({
        port: 0,
        upstreams: {
            "/api/auth": startEcho("auth"),
            "/api/blob": startEcho("blob"),
        },
        corsOrigin: "http://app.test",
        rateLimit: { limit: 100, windowMs: 60_000 },
        log: (line) => logs.push(line),
        ...options,
    });
    servers.push(gateway);
    return { base: `http://127.0.0.1:${gateway.port}`, logs };
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
    expect(logs.some((line) => line.level === "error")).toBe(true);
});

test("rate limits per client", async () => {
    const { base } = setup({ rateLimit: { limit: 2, windowMs: 60_000 } });

    expect((await fetch(`${base}/api/auth/me`)).status).toBe(200);
    expect((await fetch(`${base}/api/auth/me`)).status).toBe(200);
    expect((await fetch(`${base}/api/auth/me`)).status).toBe(429);
    // Health checks aren't counted.
    expect((await fetch(`${base}/health`)).status).toBe(200);
});

test("logs one line per request", async () => {
    const { base, logs } = setup();
    await fetch(`${base}/api/blob/files`);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
        level: "info",
        method: "GET",
        path: "/api/blob/files",
        status: 200,
    });
    expect(typeof logs[0]?.requestId).toBe("string");
});
