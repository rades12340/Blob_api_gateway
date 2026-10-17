# Blob_api_gateway

The single address the Blob_storage frontend talks to. It routes each request to the right service by path prefix, so the browser never needs to know where auth_service or blob_storage run.

```
Browser ──▶ blob_frontend (Next.js, :5173)
   │  fetch(credentials: "include")
   ▼
api_gateway (:8080)   CORS, rate limit, request ids, logging
   ├── /api/auth/*  ──▶ auth_service  (:4000)
   └── /api/blob/*  ──▶ blob_storage  (:3000)
Browser ──presigned link──▶ S3 (downloads go straight to S3)
```

The gateway only routes. Each service still checks access tokens itself, so a request that skips the gateway is no less protected.

## Requirements

- Bun v1.3 or newer
- auth_service and Blob_storage running (see their READMEs)

## Getting started

```bash
bun install
bun run dev   # http://localhost:8080, expects auth on :4000 and blob on :3000
```

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on. |
| `AUTH_URL` | `http://localhost:4000` | Where `/api/auth/*` goes. |
| `BLOB_URL` | `http://localhost:3000` | Where `/api/blob/*` goes. |
| `CORS_ORIGIN` | `http://localhost:5173` | Browser frontend allowed to call the API with cookies. |
| `RATE_LIMIT` | `300` | Requests per minute per client IP. |

### Run with Docker

Start the stacks in this order. auth_service's creates the shared `blob-storage` network, and the gateway reaches the others on it as `auth` and `blob`:

```bash
cd ../auth_service && docker compose up -d --build   # :4000
cd ../Blob_storage && docker compose up -d --build   # :3000, S3Mock on :9090
cd ../Blob_api_gateway && docker compose up -d --build   # :8080
cd ../Blob_frontend && docker compose up -d --build  # :5173, open this one
```

## What it does with a request

| Request | Result |
| --- | --- |
| `GET /health` | `200 { status: "ok" }`, not rate limited. |
| `/api/auth/<path>` | Forwarded to `AUTH_URL/<path>` with the same method, query, body and headers. |
| `/api/blob/<path>` | Forwarded to `BLOB_URL/<path>`. Uploads are streamed, not buffered. |
| `OPTIONS` on a routed path | `204` with CORS headers, answered by the gateway. |
| Anything else | `404 { error: "Not found" }` |
| Over `RATE_LIMIT` | `429 { error: "Too many requests" }` |
| Service unreachable | `502 { error: "Upstream unavailable" }`, details in the log. |

On the way in it removes connection headers and sets:

- `X-Forwarded-For`: the client's address is **appended**, so the last entry is always the real one. auth_service with `TRUST_PROXY=true` rate limits logins on that entry.
- `X-Forwarded-Host`, `X-Forwarded-Proto`.
- `X-Request-Id`: kept if the client sent one, otherwise a new UUID. It is also returned on the response and appears in the log line, so one request can be followed across services.

On the way out it passes the status, body and every `Set-Cookie` header through, and replaces any CORS headers from the services with its own (`Access-Control-Allow-Origin: CORS_ORIGIN`, `Allow-Credentials: true`).

The frontend at `localhost:5173` and the gateway at `localhost:8080` count as the same site (the port is ignored), so auth_service's `SameSite=Strict` refresh cookie is still sent.

Each request writes one JSON line to stdout: `{ level, requestId, method, path, status, ms }`.

```bash
curl -X POST localhost:8080/api/auth/register -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"password123"}'
TOKEN=$(curl -s -c cookies.txt -X POST localhost:8080/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"password123"}' | jq -r .accessToken)
curl -H "Authorization: Bearer $TOKEN" -F file=@some.pdf localhost:8080/api/blob/upload
curl -H "Authorization: Bearer $TOKEN" localhost:8080/api/blob/files
```

## Project layout

| Path | What it is |
| --- | --- |
| `src/app.ts` | `startGateway(options)`: reads config from options or env and starts `Bun.serve()`. |
| `src/proxy.ts` | `createGateway(config)`: routing table, forwarding, CORS, logging. |
| `src/rateLimit.ts` | In-memory per-IP rate limiter. |
| `src/app.test.ts` | Tests against fake upstream servers: routing, headers, cookies, uploads, CORS, 404/502, rate limit, logs. |
| `scripts/check-issue.ts` | The PR `issue` check (see [PR rules](#pr-rules)). |
| `.github/workflows/` | `ci.yml`, `pr-checks.yml` (labels, issue), `branch-name.yml`, `release.yml`. |
| `Dockerfile`, `compose.yaml` | Container image and the local Docker stack. |

## Checks

| Command | What it does |
| --- | --- |
| `bun test` | Runs the tests. |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` / `lint:fix` | Biome |

Husky runs Biome on commit. On push, it checks the branch name and runs typecheck and tests. GitHub Actions runs all three on every push and PR.

## PR rules

Same as auth_service: branches are named `<feat|fix|docs|chore>/<issue number>-short-slug`, and a PR needs a type label (`feature`, `enhancement`, `bug`, `documentation`) and a reference to an open issue. With Claude Code, "ship this" uses the `ship-pr` skill in `.claude/skills/`.
