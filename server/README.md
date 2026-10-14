# API

Go service for the community features (see [`ROADMAP.md`](../ROADMAP.md)). One binary, several modes:

```bash
go run ./cmd/server api                # serve HTTP on $PORT (default 8080)
go run ./cmd/server migrate [up|down|status|redo|reset]
```

## Layout

```text
openapi.yaml            The API contract. Edit this first, then regenerate.
cmd/server/             Entry point: config, logger, graceful shutdown
internal/api/           Generated from openapi.yaml (chi router + strict handler interface). Don't edit.
internal/httpapi/       Handler implementations and middleware (request IDs, access log, recover, JSON errors)
internal/db/            pgx pool and goose migrations (migrations/*.sql, embedded in the binary)
internal/store/         sqlc: queries/*.sql → type-safe Go. Don't edit the generated *.go.
internal/github/        GitHub OAuth (with PKCE) and the /user call
internal/config/        Environment variables
```

## Contract and codegen

```bash
go generate ./...       # Go server code (oapi-codegen) and queries (sqlc; needs cgo)
npm run api:types       # from the repo root: TS types into src/api/schema.d.ts
```

CI fails if the generated Go code is stale.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `DATABASE_URL` | (required) | Postgres connection string |
| `PORT` | `8080` | |
| `LOG_FORMAT` | `json` | `json` or `text` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `SHUTDOWN_TIMEOUT` | `15s` | How long in-flight requests get after SIGTERM |
| `DRAIN_DELAY` | `0s` | How long `/api/ready` returns 503 before the listener closes. Set it to a bit more than the load balancer's probe interval. |
| `PUBLIC_URL` | `http://localhost:5173` | The origin browsers use (the web app, which proxies `/api`). Builds the OAuth callback URL, is the trusted origin for CSRF checks, and makes cookies `Secure` when it's `https`. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | (empty) | A GitHub OAuth app. Both or neither; without them sign-in is off and `/api/auth/github/login` returns 503. |
| `ADMIN_GITHUB_IDS` | (empty) | Comma-separated numeric GitHub user IDs made admin when they sign in. IDs rather than logins, because logins can be renamed and re-registered. |
| `SESSION_TTL` | `720h` | Session lifetime. Sessions slide: once less than half is left, a request extends it. |

## Endpoints

- `GET /api/health`: liveness. Doesn't touch the database, so an outage doesn't restart the process.
- `GET /api/ready`: readiness. Returns 503 when the database ping fails or the server is draining.
- `GET /api/auth/github/login?returnTo=/path`, `GET /api/auth/github/callback`: sign in with GitHub.
- `POST /api/auth/logout`, `GET /api/me`, `GET /api/users/{handle}`.

## Sign-in and sessions

1. `/login` stores a random `state`, a PKCE verifier and `returnTo` in a 10-minute `sdd_oauth` cookie
   (scoped to `/api/auth/github`) and redirects to GitHub with scope `read:user`.
2. `/callback` checks `state` against the cookie, exchanges the code (with the verifier), reads the
   GitHub profile, upserts the user and starts a session. The GitHub token is then discarded.
   Failures redirect to `returnTo?signInError=denied|state|github|server`.
3. The session cookie `sdd_session` holds 256 random bits; the database stores only its SHA-256.
   It is `HttpOnly`, `SameSite=Lax`, and `Secure` on https.

`returnTo` must be a same-site path (no `//host`, no `/api/…`), so the flow can't be used as an open
redirect. Mutating requests from other origins are rejected with Go's `http.CrossOriginProtection`
(`Sec-Fetch-Site` / `Origin`), with `PUBLIC_URL` trusted because the Vercel rewrite changes the Host.

To try it locally, create a GitHub OAuth app with the callback URL
`http://localhost:5173/api/auth/github/callback`, put its ID and secret in `.env`, then run the API
and `npm run dev`.

Every response carries `X-Request-Id` (an upstream one is reused if it's safe). Errors are JSON
`{ "message", "requestId" }`, the shape `src/api/client.ts` reads.

## Tests

```bash
go test ./...
TEST_DATABASE_URL=postgres://sdd:sdd@localhost:5432/sdd_test?sslmode=disable go test -p 1 ./...
```

`TEST_DATABASE_URL` is reset by the db and store tests (hence `-p 1`), so never point it at real data.
`docker compose up` creates `sdd_test` for you.

## Docker

```bash
docker build --build-arg VERSION=$(git rev-parse HEAD) -t sdd-api server
```
