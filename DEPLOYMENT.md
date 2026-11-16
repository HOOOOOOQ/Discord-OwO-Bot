# Deployment

## Requirements

| Component         | Version                                                                                 | Notes                                                |
| ----------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Node.js           | ≥ 20 (tested on 22)                                                                     | `engines.node` in `package.json`                     |
| MariaDB / MySQL   | 10.6+ / 8.0+                                                                            | schema in `secret/CREATE-OWO-TABLES.sql` (87 tables) |
| Redis             | 6+                                                                                      | cooldowns, XP, prefixes, pub/sub                     |
| Native toolchain  | gcc/g++, python3, libcairo2-dev, libpango1.0-dev, libjpeg-dev, libgif-dev, librsvg2-dev | only for `canvas`                                    |
| Internal services | `SHARDER_HOST`, image-gen (`GEN_API_HOST`/`IMAGE_GEN_*`), optional Patreon/DBL/Weeb.sh  | required by the sharder and image commands           |

## 1. Configuration

```bash
cp .env.example .env    # then edit
```

Minimum for a working instance:

```ini
BOT_TOKEN=...
OWNER_IDS=<your discord user id>     # empty => owner commands disabled
MYSQL_HOST / MYSQL_USER / MYSQL_PASS / MYSQL_DATABASE
REDIS_HOST
```

There is **no default owner**. If `OWNER_IDS` is empty the bot logs a warning and
every owner-only command (including `eval`) is denied. `DEBUG` defaults to
`false`; while enabled the bot only answers in `DEBUG_WHITELIST` guilds.

`PREFIX` sets the bot-wide default prefix and defaults to `o` (the bot is called
**OCEAN**; `sharder.name` in `src/data/config.json` and the `< OCEAN … >` help
title come from the same rebrand). Servers can still change their own prefix with
`o prefix <new prefix>`; the global prefix keeps working alongside it.

### Cowoncy grants (`grant`)

`grant` creates cowoncy out of nothing, so it is allowlisted instead of being
open to everyone (it is **not** the same as `give`, which moves your own
balance):

```bash
# .env — comma separated ids
COWONCY_ADMIN_IDS=111111111111111111,222222222222222222
COWONCY_ADMIN_ROLE_IDS=333333333333333333   # per-server role ids
COWONCY_GRANT_MAX=1000000000                # cap for one grant (default 1e9)
```

Usage: `o grant @user 1000` (aliases: `addcash`, `addmoney`, `topup`). Owners in
`OWNER_IDS` can always use it; everyone else needs an allowlisted id or role.
With both lists empty the command is **owner-only**, so nothing changes for
public instances. The role check reads the member's roles in the guild where the
command is used, and the grant is written with a parameterized
`INSERT ... ON DUPLICATE KEY UPDATE`, then audited
(`audit action=cowoncy-grant ...`).

## 2. Database

```bash
mysql -u root -p -e "CREATE DATABASE owo CHARACTER SET utf8mb4"
mysql -u root -p owo < secret/CREATE-OWO-TABLES.sql
mysql -u root -p owo < secret/OWO-TABLE-DATA.sql   # optional seed data
```

The schema is additive-compatible with the existing 87 tables; nothing in this
repair drops or renames a table or column. No migration is required for an
existing deployment.

## 3. Install and run

```bash
npm ci            # needs the native toolchain above for canvas
npm run verify:commands
node index.js
```

The master process asks `SHARDER_HOST` for its shard range and then forks
`CLUSTERS` (default 60, override with `CLUSTERS`) cluster processes. In debug
mode a single shard/cluster is started.

### Signals

`SIGTERM`/`SIGINT` trigger a graceful shutdown: MySQL pool drains, Redis quits,
sockets close, then the process exits. An `uncaughtException` is logged with
context, the same shutdown runs, and the process exits with code 1 so the
supervisor/sharder respawns a clean process (`EXIT_ON_FATAL=false` opts out).

## 4. Docker

```bash
cp .env.example .env      # fill in BOT_TOKEN, OWNER_IDS, MYSQL_ROOT_PASSWORD, MYSQL_PASS
docker compose up -d --build
docker compose ps        # bot health = MySQL + Redis reachable
docker compose logs -f bot
```

- `Dockerfile` is multi-stage: the builder compiles `canvas`, the runtime image
  contains only production dependencies (non-root user, `tini` as PID 1).
- `docker-compose.yml` starts MariaDB (schema auto-imported on first boot) and
  Redis with health checks and named volumes.
- The image health check runs `scripts/healthcheck.js` (MySQL + Redis TCP).
- Docker is optional: nothing in the code path requires it.

## 5. Operational notes

- `GET /metrics` does not exist. `METRICS_ENABLED=true` forwards counters to
  StatsD/Datadog; in-process counters are always maintained
  (`src/utils/metrics.js`). The InfluxDB log shipping is optional and only
  active when `INFLUXDB_HOST` is set.
- Logs are single-line, timestamped, level-tagged and cluster-tagged
  (`cluster:12`), with secrets redacted. `LOG_LEVEL=debug` for diagnostics.
- Horizontal scaling: shards are allocated by the sharder server; every host
  gets its own range. Keep `CLUSTERS` × `MYSQL_CONNECTION_LIMIT` below the
  database's `max_connections`.
- Upgrade path: `git pull && npm ci && node index.js`. Roll back by restoring
  the previous commit; no destructive migration is performed by the bot.
