# Deployment

## Requirements

| Component         | Version                                                                                 | Notes                                                |
| ----------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Node.js           | ≥ 20 (tested on 22)                                                                     | `engines.node` in `package.json`                     |
| MariaDB / MySQL   | 10.6+ / 8.0+                                                                            | schema in `secret/CREATE-OWO-TABLES.sql` (87 tables) |
| Redis             | 6+                                                                                      | cooldowns, XP, prefixes, pub/sub                     |
| Native toolchain  | gcc/g++, python3, libcairo2-dev, libpango1.0-dev, libjpeg-dev, libgif-dev, librsvg2-dev | optional: hanya untuk `canvas` (memegen)             |
| Internal services | image-gen (`GEN_API_HOST`/`IMAGE_GEN_*`), optional Patreon/DBL/Weeb.sh                  | `SHARDER_HOST` is optional (see §3)                  |

## 1. Configuration

```bash
cp .env.example .env    # then edit
```

Minimum for a working instance:

```ini
BOT_TOKEN=...
OWNER_IDS=<your discord user id>     # empty => owner commands disabled
DATABASE_URL=mysql://owo:password@172.18.0.1:3306/owo
REDIS_URL=redis://:password@172.18.0.1:6379/0
PREFIX=o
CLUSTERS=2
```

`DATABASE_URL`/`REDIS_URL` are the simple path: one connection string per
service (`mysql://`, `mariadb://`, `redis://` or `rediss://` for TLS). The older
`MYSQL_HOST/MYSQL_USER/MYSQL_PASS/MYSQL_DATABASE` and `REDIS_HOST/REDIS_PASS`
variables still work and are used when no URL is set — a URL always wins. There
is **no MongoDB** in this project; the database is MySQL/MariaDB.

There is **no default owner**. If `OWNER_IDS` is empty the bot logs a warning and
every owner-only command (including `eval`) is denied. `DEBUG` defaults to
`false`; while enabled the bot only answers in `DEBUG_WHITELIST` guilds — and if
the whitelist is empty the bot ignores _every_ guild, which looks exactly like
"the bot is dead".

`MESSAGE CONTENT INTENT` is privileged and must be enabled in the Discord
Developer Portal (Bot → Privileged Gateway Intents) or the bot will connect and
ignore every command. `ERIS_MESSAGE_CONTENT` controls how the bot treats it:
`auto` (default, request it only when the portal allows), `on`, `off`. To pin the
whole intent bitmask use `ERIS_INTENTS` (names or numbers, e.g.
`allNonPrivileged,messageContent`).

Presence (status dot + activity line) is configured with `BOT_STATUS`,
`BOT_ACTIVITY_TYPE`, `BOT_ACTIVITY_TEXT` (`{guilds}`/`{users}`/`{shards}`/
`{prefix}` placeholders), `BOT_ACTIVITY_URL` for streaming, and
`BOT_PRESENCE_REFRESH_SEC` to re-apply it periodically. It is applied on every
`ready` and after a shard resumes, so no external service is involved.

Run the self-check at any time:

```bash
node index.js --doctor             # token, intents, presence, shard source, DB/Redis reachability
node index.js --doctor --connect   # additionally performs a real gateway login (stop the bot first)
```

`DD_TRACE_ENABLED=false` skips loading dd-trace and saves tens of MB of RSS on
small panels.

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
npm ci            # canvas is optional: without the toolchain it is skipped and memegen is disabled
npm run verify:commands
node index.js
```

The master process resolves its shard range and then forks `CLUSTERS` cluster
processes (override `CLUSTERS`; the repo default of 60 is meant for the public
bot, 1–2 is right for a small server). Shards come from `SHARDS`/`SHARD_FIRST`/
`SHARD_LAST`, else `SHARDER_HOST` when that (upstream-private) service exists,
else Discord's `GET /gateway/bot` recommendation, else a single shard. In debug
mode a single shard/cluster is started.

Startup logs tell you what was decided:

```
[BOOT] OCEAN starting — node v20.x, pid 123, CLUSTERS=2
[SHARD] shards 0~0 of 1 (Discord's recommendation)
[CONFIG] prefix=o debug=false clusters=2 shards=1 intents=130813
discord: token ok — Ocean#5352 (id 1571…)
discord: application OCEAN (id 1571…); MESSAGE CONTENT INTENT enabled
[CLUSTER] worker 1 forked / [CLUSTER] worker 1 online
[GATEWAY] connecting with presence online — playing "o help" (attempt 1)
[GATEWAY] shard 0 socket open — sent IDENTIFY, waiting for READY
[SHARD] shard 0 READY after 412ms
[GATEWAY] all shards READY — 1 shard(s), 1 guild(s)
bot ready: Ocean#5352 in 1 guild(s), shard 0 - 0 — ONLINE (status online, playing "o help")
Bot is online. Commands accept the prefix "o" (try "ohelp")
[HEALTH] OCEAN IS ONLINE — Ocean#5352
```

eris identifies with `presence.status = "offline"` unless the application sets it
before connecting, which is why `src/utils/gatewayBoot.js` writes the presence
before `connect()` and `src/utils/readyState.js` replays the ready handler once
(eris-sharder loads the app from inside its own `ready` listener).

A cluster that dies is forked again by eris-sharder (`cluster 0 died … Restarting`),
so shard crashes self-heal while the master process keeps running.

If the token is rejected, the intent is disabled, or a shard disconnects, the
log now says so explicitly (e.g. `4004` = bad token, `4014` = disallowed intent)
instead of leaving a process that looks alive but never comes online.

### Signals

`SIGTERM`/`SIGINT` trigger a graceful shutdown: MySQL pool drains, Redis quits,
sockets close, then the process exits. An `uncaughtException` is logged with
context, the same shutdown runs, and the process exits with code 1 so the
supervisor/sharder respawns a clean process (`EXIT_ON_FATAL=false` opts out).

> Pterodactyl 1.x: ada panduan khusus + egg siap import di
> [PTERODACTYL.md](PTERODACTYL.md) (image `pterodactyl/Dockerfile`, karena
> image `nodejs_20` bawaan tidak punya library `canvas`).

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
