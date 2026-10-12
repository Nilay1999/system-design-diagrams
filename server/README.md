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
internal/config/        Environment variables
```

## Contract and codegen

```bash
go generate ./...       # Go server code (oapi-codegen, pinned as a go tool)
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

## Endpoints

- `GET /api/health`: liveness. Doesn't touch the database, so an outage doesn't restart the process.
- `GET /api/ready`: readiness. Returns 503 when the database ping fails or the server is draining.

Every response carries `X-Request-Id` (an upstream one is reused if it's safe). Errors are JSON
`{ "message", "requestId" }`, the shape `src/api/client.ts` reads.

## Tests

```bash
go test ./...
TEST_DATABASE_URL=postgres://sdd:sdd@localhost:5432/sdd_test?sslmode=disable go test ./...
```

`TEST_DATABASE_URL` is reset by the migration tests, so never point it at real data.
`docker compose up` creates `sdd_test` for you.

## Docker

```bash
docker build --build-arg VERSION=$(git rev-parse HEAD) -t sdd-api server
```
