import { createGateway, type GatewayConfig } from "./proxy";

export type GatewayOptions = Partial<GatewayConfig> & { port?: number };

export function startGateway(options: GatewayOptions = {}) {
    const env = process.env;
    const handle = createGateway({
        upstreams: options.upstreams ?? {
            "/api/auth": env.AUTH_URL ?? "http://localhost:4000",
            "/api/blob": env.BLOB_URL ?? "http://localhost:3000",
        },
        corsOrigin:
            options.corsOrigin ?? env.CORS_ORIGIN ?? "http://localhost:5173",
        rateLimit: options.rateLimit ?? {
            limit: Number(env.RATE_LIMIT ?? 300),
            windowMs: 60_000,
        },
        trustProxy: options.trustProxy ?? env.TRUST_PROXY === "true",
        log: options.log ?? ((line) => console.log(JSON.stringify(line))),
    });

    return Bun.serve({
        port: options.port ?? Number(env.PORT ?? 8080),
        // Uploads are limited by blob_storage (25 MB by default); this only
        // keeps far larger bodies out of the gateway.
        maxRequestBodySize: 100 * 1024 * 1024,
        fetch: handle,
    });
}

if (import.meta.main) {
    const server = startGateway();
    console.log(`API gateway running at ${server.url}`);
}
