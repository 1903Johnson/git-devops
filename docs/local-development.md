# Local development

Everything the platform depends on, on the same versions CI uses.

## Prerequisites

- Docker Engine with the Compose plugin (`docker compose version` ≥ 2)
- Node 22 and pnpm 10 (`corepack enable`)

## Bring it up

```bash
cp .env.example .env          # safe local defaults; adjust ports if they clash
docker compose up -d          # first run pulls images, so give it a minute
docker compose ps             # every service should read "healthy"
pnpm install
pnpm -r --if-present run migrate:test    # applies the schema, verifies RLS coverage
```

| Service | Where | Why it is here |
|---|---|---|
| PostgreSQL 16 | `localhost:5432` | System of record. Same version as CI. |
| Redis 7 | `localhost:6379` | Cache, sessions, rate limiting, job queue. |
| MinIO | `localhost:9000`, console `:9001` | S3-compatible storage: sermon media, exports, check-in labels. |
| Mailpit | SMTP `:1025`, inbox `http://localhost:8025` | Catches every outbound email. |

Two databases exist: `church_dev` for running the app, and `church_test` for the
integration and isolation suites. The second is created on first start by
`infra/local/init-databases.sh`.

**Nothing this stack sends can reach a real person.** Mailpit swallows all outbound mail,
which matters more here than on most projects — the test data is shaped like a
congregation, complete with children's records.

## Tear it down

```bash
docker compose down           # stop, keep data
docker compose down -v        # stop and delete volumes — a clean slate
```

## Reset the database

```bash
docker compose down -v && docker compose up -d
pnpm -r --if-present run migrate:test
```

`down -v` is the only way to re-run `init-databases.sh`: Postgres skips
`/docker-entrypoint-initdb.d` whenever the data volume already exists, so editing that
script has no effect until the volume is gone.

## Running the suites

```bash
DATABASE_URL=$TEST_DATABASE_URL pnpm -r --if-present run test:integration
DATABASE_URL=$TEST_DATABASE_URL pnpm -r --if-present run test:isolation
pnpm run verify                          # boundaries, docs, contracts, lint, types, unit
```

Point these at `church_test`, not `church_dev`: the suites truncate and recreate freely.

## Troubleshooting

**A port is already in use.** Every published port is overridable — set `POSTGRES_PORT`,
`REDIS_PORT`, `MINIO_PORT`, `MINIO_CONSOLE_PORT`, `SMTP_PORT`, or `MAILPIT_UI_PORT` in
`.env` and bring the stack back up. A native PostgreSQL on 5432 is the usual culprit.

**A service sits at "starting" forever.** `docker compose logs <service>` shows why. A
Postgres volume left over from an older, incompatible major version is the common cause;
`docker compose down -v` clears it.

**`migrate:test` cannot connect.** Check `DATABASE_URL` points at the port you published,
and that `docker compose ps` shows postgres healthy rather than merely running — the
container accepts TCP connections a moment before Postgres is ready for queries.

**The schema looks stale.** Migrations are immutable once applied; the runner refuses to
re-run a file whose checksum changed. During development, `docker compose down -v` and
re-migrate rather than editing an applied migration.

**Image pulls fail behind a corporate proxy or restricted network.** The stack needs
Docker Hub, including its CDN (`production.cloudfront.docker.com`). If that is blocked,
the images cannot be fetched and no amount of compose configuration will help — use a
registry mirror your network permits.
