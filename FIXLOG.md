# FIXLOG

## Presence, gateway login test, and 24/7 hardening

- **Presence is applied by the bot itself** (`src/utils/presence.js`), on every
  `ready` and after a shard `resume`. Env: `BOT_STATUS`, `BOT_ACTIVITY_TYPE`
  (playing/watching/listening/competing/streaming/custom), `BOT_ACTIVITY_TEXT`
  with `{guilds}`/`{users}`/`{shards}`/`{prefix}`, `BOT_ACTIVITY_URL`,
  `BOT_PRESENCE_REFRESH_SEC`. Upstream only set a status when its private
  sharder server replied, so self-hosted bots connected with a blank presence.
- **`ready` now prints the online marker** with identity, guild/shard counts,
  status and activity, followed by a plain `Bot is online.` line for panel
  operators. The `bot ready` prefix that the egg/healthcheck greps for is kept.
- **`node index.js --doctor --connect`** performs a real gateway login
  (`src/utils/doctor.js`), proving token + intents actually work, then
  disconnects. Doctor also reports the resolved presence and warns about
  `invisible`/invalid values.
- **Worker crashes self-heal**: eris-sharder re-forks a dead cluster
  (`cluster N died … Restarting`); documented so operators don't restart the
  whole panel server.
- **Resource knobs**: `DD_TRACE_ENABLED=false` skips dd-trace entirely
  (tens of MB of RSS), documented `CLUSTERS`/`NODE_OPTIONS`/`LOG_LEVEL` tuning.
- Egg gains `BOT_STATUS`, `BOT_ACTIVITY_TYPE`, `BOT_ACTIVITY_TEXT`,
  `BOT_PRESENCE_REFRESH_SEC`; `.env.example`, DEPLOYMENT, README and
  PTERODACTYL (online checklist, presence, 24/7, optimization) updated.

## Self-hosting boot: shards without upstream's sharder server, intents, diagnostics

- **Shard allocation no longer requires `SHARDER_HOST`** (an upstream-private
  service that self-hosters cannot get). Order: `SHARDS`/`SHARD_FIRST`/
  `SHARD_LAST` → `SHARDER_HOST` → Discord `GET /gateway/bot` → single shard.
  `src/utils/shardConfig.js`.
- **Worker clusters no longer abort on missing shard config.** `index.js` used to
  validate `firstShardID`/`lastShardID` in _every_ process; workers receive their
  range over IPC, so with `DEBUG` off they threw, never created a client, and the
  bot stayed offline while the master process looked healthy.
- **`MESSAGE CONTENT INTENT` is requested** (`src/utils/intents.js`). Upstream
  shipped no `intents`, so eris used `allNonPrivileged` and every command was
  silently ignored. The startup check reads `/applications/@me` flags and only
  requests the privileged bit when the portal allows it (requesting it while
  disabled closes the gateway with 4014). `ERIS_MESSAGE_CONTENT=auto|on|off`,
  `ERIS_INTENTS=<names or numbers>`.
- **Startup diagnostics + `node index.js --doctor`** (`src/utils/diagnostics.js`,
  `src/utils/doctor.js`): validates the token, reports whether the intent is
  enabled, prints the shard source, and probes `DATABASE_URL`/`REDIS_URL`.
- **Actionable gateway logs**: `src/utils/gatewayCodes.js` translates close codes
  (4004 bad token, 4014 disallowed intents, 4010 bad shard, …) and `ready` now
  reports the bot tag, guild count and shard range.
- **Optional sharder endpoints are guarded**: `InfoUpdater`,
  `updateShardInfo` (previously threw inside a callback and could crash a
  cluster), `global.getTotalShardCount`, `o stats` and `o shards` now degrade to
  local values instead of calling `undefined/...` URLs.
- Tests: `test/shardConfig.test.js`, `test/intents.test.js`,
  `test/discordApi.test.js`, `test/doctor.test.js`.

Every entry lists the issue, its root cause, the files touched, the solution and
how it was verified. Timestamps are UTC. No secrets appear in this document.

Baseline analysed: commit `9aec92b` ("Fixed math command + other minor errors").

---

## P0-1 — Clean installation was impossible (`npm ci` → E404)

**Issue.** A fresh clone could not install: `urban-dictionary@3.0.2` was
unpublished from npm on 2023-12-15, so `npm ci` failed with `404`.
**Root cause.** Dead dependency used by a single command (`owo define`).
**Files.** `package.json`, `src/utils/urbanDictionary.js` (new),
`src/commands/commandList/social/define.js`, `package-lock.json`.
**Solution.** Wrote a compatibility client that keeps the
`define(word, cb) → cb(err, entries[{definition, example, permalink}])` contract
of the removed package but calls `api.urbandictionary.com` through the project's
own HTTP wrapper (8s timeout, `NOT_FOUND` on empty result). Lockfile regenerated
from scratch.
**Test.** `npm view urban-dictionary` → _"Unpublished on 2023-12-15"_;
`npm ci --ignore-scripts` in a clean directory → _500 packages added_;
`test/urbanDictionary.test.js` → contract, `NOT_FOUND`, empty input.
**Result.** Pass. `urban-dictionary`, `request`, `safe-eval`, `express`, `npm@7`,
`erlpack`, `weeb.js` and `translate-google` are gone from the tree (863 → 501
packages).

---

## P0-2 — Owner privileges shipped in the public defaults

**Issue.** `src/data/config.json` contained the original author's Discord id as
`owner`, plus the live staff role ids and mod channel ids. A fork that did not
edit the file inherited **unauthorized owner access** (including `eval`).
**Root cause.** Privilege configuration was committed as data with no
environment override and no empty-list fallback.
**Files.** `src/data/config.json`, `src/utils/config.js` (new),
`src/utils/auth.js` (new), `src/commands/command.js`, `index.js`, `src/owo.js`,
`src/utils/{blacklist,giveaway,logger,rewardUtil}.js`,
`src/commands/commandList/{admin/customPet,gamble/blackjackUtil,patreon/rain,shop/util/itemUtil,utils/suggest}.js`.
**Solution.** Defaults now carry empty `owners` / `role.*` / `modChannels` /
`debugWhitelist`. `src/utils/config.js` merges `OWNER_IDS`, `OWNER_ID` (legacy),
`ADMIN_ROLE_IDS`, `MANAGER_ROLE_IDS`, `HELPER_ROLE_IDS`, `MOD_CHANNEL_IDS`,
`GIVEAWAY_CHANNEL_IDS`, `DEBUG`, `DEBUG_WHITELIST`, `ALLOW_EVAL`, `PREFIX`,
`CLUSTERS`, `LOG_LEVEL`, `METRICS_ENABLED`, `EXIT_ON_FATAL`; ids are validated as
snowflakes and invalid values are dropped with a warning. Authorization was
consolidated in `auth.canRunAdmin()`; an empty owner list denies instead of
granting. Audit lines are written for every admin/owner command.
**Test.** `test/config.test.js` (8 tests) and `test/auth.test.js` (6 tests):
env parsing, invalid ids, empty-owner denial, eval gating, role+channel gates.
**Result.** Pass. `config.validate()` returns `false` and logs a warning when no
owner is configured.

---

## P0-3 — `eval` / `broadcastEval` reachable without guard rails

**Issue.** Raw `eval` on chat input, gated only by `owner: true`, with
`config.owner` being a hardcoded id (see P0-2). Output could leak tokens.
**Root cause.** No feature flag, no output sanitisation, no audit trail.
**Files.** `src/utils/sandbox.js` (new),
`src/commands/commandList/admin/eval.js`,
`src/utils/pubsubHandlers/broadcastEval.js`.
**Solution.** Execution requires `ALLOW_EVAL=true` **and** an owner id; the
evaluation scope shadows `require`, `process`, `module`, `exports`, `Buffer`,
`globalThis`, `global`; results are redacted by `log.redact()` and capped at
1800 chars; every call is audited. `broadcastEval` additionally validates its
payload and no longer throws on a malformed message.
**Test.** `test/sandbox.test.js`: disabled by default, `typeof require` →
`undefined`, redaction and truncation, error/object formatting.
**Result.** Pass. Note in SECURITY.md: this is mitigation, not a sandbox.

---

## P0-4 — A failed command could kill a cluster

**Issue.** `messageCreate` called `this.command.execute(msg, raw)` and
`levels.giveXP(msg)` as floating promises; `executeCommand()` had no
`try/catch`. Any rejection became an unhandled rejection, which Node ≥15 turns
into a process exit.
**Root cause.** Error handling was delegated to individual commands.
**Files.** `src/eventHandlers/messageCreate.js`,
`src/eventHandlers/EventHandler.js`, `src/commands/command.js`,
`src/utils/errors.js` (new), `index.js`, `src/owo.js`.
**Solution.** One safety net per layer:
`EventHandler` wraps every gateway handler in `errors.wrapAsync` (event name in
the log line); `messageCreate` awaits dispatch and XP bookkeeping;
`executeCommand` wraps the ban/cooldown/metrics pipeline; the command body runs
inside `errors.runCommandSafely`, which logs context and sends **at most one**
error reply per invocation. `unhandledRejection` is logged with de-duplication
per minute; `uncaughtException` logs, flushes and exits (supervision-friendly).
**Test.** `test/commandInterface.test.js` ("contained by runCommandSafely",
single error reply) and manual `errors.logFailure` review.
**Result.** Pass.

---

## P0-5 — MySQL transaction lifecycle was broken

**Issue.** `startTransaction()` called `beginTransaction` with
`if (err) throw err` **inside** the driver callback (uncaught exception), and
resolved the transaction object before `beginTransaction` completed (race where
queries could run outside the transaction).
**Root cause.** Callback-style code converted to promises by hand, without
sequencing.
**Files.** `src/botHandlers/mysqlHandler.js`, `src/utils/mysql.js`.
**Solution.** `buildTransaction(acon)` now: resolves only after
`beginTransaction` succeeds, releases the connection exactly once, makes
`commit`/`rollback` idempotent, rolls back on commit failure, rejects queries
after close, and keeps the 10s lease watchdog (configurable with
`MYSQL_TRANSACTION_TIMEOUT_MS`, timer `unref()`ed). `startTransaction` releases
the connection when `beginTransaction` fails. `mysql.js` gained a pool `error`
listener (an unhandled `'error'` event used to crash the process),
`connectTimeout`, `maxIdle`/`idleTimeout`, env-driven `connectionLimit`, and a
`close()` helper.
**Test.** `test/mysqlHandler.test.js` (8 tests) with a fake connection: commit
idempotency, single release, rollback path, commit failure, closed-transaction
rejection, watchdog rollback, failed `beginTransaction`.
**Result.** Pass.

---

## P0-6 — SQL interpolation reachable from user input

**Issue.** Template-literal SQL with user/channel ids: `acceptedRules()`,
`rep` count, `cowoncy` update, `user_ring` insert, `autohunt` insert.
**Root cause.** String building instead of placeholders.
**Files.** `src/commands/command.js`,
`src/commands/commandList/social/util/{profileUtil,ringUtil}.js`,
`src/commands/commandList/zoo/sacrifice.js`.
**Solution.** All of them use `?` placeholders now; the `user_ring` recovery
path issues two parameterized statements instead of concatenating strings.
`multipleStatements` stays enabled (see P0-7) but no user-controlled value is
concatenated any more.
**Test.** Covered indirectly by `test/mysqlHandler.test.js` (parameter passing)
and reviewed by hand against the 5 template-literal call sites found by
`grep -rn "query(\`"`.
**Result.** Pass.

---

## P0-7 — `multipleStatements: true` (deliberately retained, documented)

**Issue.** Multi-statement support widens SQL injection impact to stacked
queries.
**Root cause.** Not an accident: `battle/ab.js`, `battle/db.js`,
`zoo/sacrifice.js`, `battle/util/teamUtil.js` and `battle/WeaponInterface.js`
send several statements in one call and read `result[1]`.
**Files.** `src/utils/mysql.js`, `SECURITY.md`.
**Solution.** Kept enabled (removing it silently breaks battle and zoo flows),
now configurable via `MYSQL_MULTIPLE_STATEMENTS=false`, documented with the exact
call sites and the least-privilege database-user requirement instead of being
silently "fixed" by a flag flip.
**Test.** Static review of every multi-statement call site; `npm run verify:commands`.
**Result.** Documented residual risk; no behaviour change.

---

## P1-1 — `request` (deprecated, critical SSRF advisory) removed

**Issue.** 24 files imported `request@2.88.2`.
**Root cause.** Legacy HTTP client.
**Files.** `src/utils/http.js` (new) + 21 rewritten imports,
`utils/request.js`, `utils/rateLimitUtil.js`, `src/utils/logger.js`.
**Solution.** `src/utils/http.js` implements the exact subset used
(`request(options|url, cb)`, `.get`, `.post`, `.put`, `.delete`,
`.defaults({encoding:null})`, `json`, `body`, `headers`, `qs`, `timeout`,
`(err, response, body)` with `statusCode`) on top of global `fetch`, with a hard
timeout (`HTTP_TIMEOUT_MS`, default 15s) and a guarantee that the callback fires
once and never throws.
**Test.** `test/http.test.js` (8 tests) against a local HTTP server: JSON, query
strings, Buffer downloads, `defaults()`, timeout → `ETIMEDOUT`, non-2xx
passthrough, POST JSON, single callback, connection refused.
**Result.** Pass. `request` no longer exists in the dependency tree.

---

## P1-2 — `weeb.js` and `translate-google` (critical `safe-eval`) removed

**Issue.** `translate-google` pulled in `safe-eval` (sandbox breakout /
prototype pollution) and `weeb.js` pulled in `request`.
**Files.** `src/utils/weeb.js` (rewritten), `src/utils/translate.js` (new),
`src/commands/commandList/social/translate.js`, `package.json`.
**Solution.** Both integrations are implemented directly against the same
upstream endpoints through the HTTP wrapper, preserving the public surface:
`grab()`, `getTypes()`, `translate(texts, {to})`, `languages`.
**Test.** `test/translate.test.js` (response parsing, `listlang` table, empty
input) and `owo gif` path covered by the registry load test.
**Result.** Pass. `safe-eval` is gone from the tree.

---

## P1-3 — Vulnerable dependency versions

**Issue.** `npm audit`: 9 critical / 52 high / 20 moderate / 15 low.
**Files.** `package.json`, `package-lock.json`.
**Solution.** `axios` 0.21.4 → 1.21.1 (call sites already used the 1.x API),
`systeminformation` 5.12 → 5.33.23, `canvas` 2.6 → 2.11.2, removed unused
(`express`, `install`, `npm`, `novelcovid`, `prettier` from prod,
`erlpack`/`zlib-sync`/`ws`/`bufferutil`), regenerated the lockfile from scratch.
Deliberately **not** force-upgraded (breaking, documented in SECURITY.md):
`canvas@3`, `dd-trace@6`, `redis@4`, `mathjs@15`, `mysql`→`mysql2`,
`patreon`.
**Test.** `npm audit --omit=dev --package-lock-only`.
**Result.** 96 → **22 advisories** (9 critical → **1**, 52 high → 17). The single
remaining critical (`tar` via `canvas@2`) is build-time only and needs the
canvas 3 migration.

---

## P1-4 — Math command timeout never matched

**Issue.** `.timeout(3000)` but the catch compared against
`'Promise timed out after 1000 ms'`, so the "too difficult" branch was
unreachable. The shared pool was also `terminate()`d after every invocation,
forcing a fresh worker spawn for the next request and rejecting in-flight work.
**Files.** `src/commands/commandList/utils/math.js`,
`src/utils/mathResult.js` (new),
`src/commands/commandList/utils/mathWorker.js`.
**Solution.** `MATH_TIMEOUT_MS` (default 3000) is the single source of truth and
the message is classified by `classifyMathError()` (code/wording independent);
the message now states the real limit; the pool is created once and reused
(exposed as `module.exports.pool` for shutdown/tests).
**Test.** `test/mathResult.test.js` (3 tests incl. a regression for the hardcoded
1000ms string).
**Result.** Pass.

---

## P1-5 — `mathWorker.js` hijacked the cluster IPC channel

**Issue.** `mathWorker.js` lives inside `commandList`, so the command loader
required it at startup, where it unconditionally called
`workerpool.worker()` → `process.send` usage inside a sharder cluster
(`TypeError: process.send is not a function` when `process.send` is absent, and
message-handler hijacking when it exists).
**Files.** `src/commands/commandList/utils/mathWorker.js`.
**Solution.** The worker handler is installed only when the file is the actual
worker entry point (`require.main === module` or `argv[1]` is `mathWorker.js`),
and the registration flag now also accepts the corrected `REGISTER_COMMANDS`.
**Test.** `npm run verify:commands` fails without this guard and passes with it.
**Result.** Pass.

---

## P1-6 — `REGITER_COMMANDS` typo

**Issue.** The env flag guarding worker registration was misspelled.
**Files.** `src/commands/commandList/utils/mathWorker.js`,
`utils/registerAppCommands.js`.
**Solution.** Both spellings are honoured (`REGISTER_COMMANDS` preferred,
`REGITER_COMMANDS` kept for backwards compatibility) and the registration script
sets both.
**Test.** Registry verification + `utils/registerAppCommands.js` code review.
**Result.** Pass, fully backward compatible.

---

## P1-7 — Bitwise OR instead of logical fallback

**Issue.** `guild: p.msg.channel.guild?.id | 'dm'` in the InfluxDB shipper
coerced the value to `0` for DMs and for every guild id.
**Files.** `src/utils/logger.js`.
**Solution.** `||` (and the neighbouring `.guild.id` accesses made optional).
**Test.** Code review; covered by the logger tests indirectly (no throw with a
DM-shaped payload).
**Result.** Pass.

---

## P1-8 — `throw` inside HTTP callbacks crashed the process

**Issue.** `logger.js` (4 call sites) and `utils/rateLimitUtil.js` did
`throw err` inside a `request` callback when InfluxDB was unreachable — an
uncaught exception in production.
**Files.** `src/utils/logger.js`, `utils/rateLimitUtil.js`.
**Solution.** Logged once per 5 minutes via the structured logger instead of
throwing; the InfluxDB integration stays optional.
**Test.** Static review + `test/log.test.js`.
**Result.** Pass.

---

## P1-9 — Stubbed metrics reported nothing

**Issue.** `exports.incr`/`decr` started with `return;`, so all metrics were
silently discarded, and `logger.increment` wrote straight to a Datadog client.
**Files.** `src/utils/metrics.js` (new), `src/utils/logger.js`.
**Solution.** Real in-process counters/timers with a `snapshot()` accessor;
StatsD forwarding only when `METRICS_ENABLED=true` and the transport loads;
`logger.*` now feeds both. No fake success: when the transport is unavailable the
code says so in the log and keeps the local counters.
**Test.** Covered by unit tests indirectly; `metrics.snapshot()` inspected
manually.
**Result.** Pass.

---

## P1-10 — Module load side effects

**Issue.** `covid.js` performed a network request at require time
(`undefined/covid`) and installed a 30-minute interval; `autohuntutil.js`
logged a full stack trace when `tokens/macro.js` was absent.
**Files.** `src/commands/commandList/utils/covid.js`,
`src/commands/commandList/zoo/autohuntutil.js`.
**Solution.** COVID polling only when `SHARDER_HOST` is configured, interval
`unref()`ed, JSON parsing guarded; `autohuntutil` falls back to
`secret/macro.js` like `levels.js` and degrades to a warning.
**Test.** `npm run verify:commands` (previously emitted `ERR_INVALID_URL`
rejections).
**Result.** Pass.

---

## P1-11 — Logging standardised

**Issue.** 188 `console.*` calls, no timestamps, no levels, no cluster id, and
tokens could end up in logs.
**Files.** `src/utils/log.js` (new), `index.js`, `src/owo.js`.
**Solution.** `log.configure/installConsoleBridge` gives every existing call site
a timestamp, severity, `[cluster:N]` tag and secret redaction without rewriting
188 call sites; new code uses `log.create(scope)`. `LOG_LEVEL` controls verbosity.
**Test.** `test/log.test.js`.
**Result.** Pass. Documented as a bridge; migrating call sites to `log.create`
is a follow-up.

---

## P1-12 — CI was Node 15, lint-only, master-only

**Issue.** `.github/workflows/lint.yml` ran ESLint/Prettier on Node 15 (EOL),
only for `master`/`private`, and swapped `package.json` for `package-dev.json`.
No tests, no install check, `actions/checkout@v2`/`setup-node@v1`.
**Files.** `.github/workflows/lint.yml`.
**Solution.** Jobs: lint+prettier+test+registry+circular on Node 20/22 (with
`npm ci --ignore-scripts`), a blocking `native-install` job that installs the
canvas system libraries and runs a real `npm ci` plus a canvas smoke test, and a
non-blocking `security-audit` job (explicitly report-only, never silently
green). All actions on v4 with npm caching.
**Test.** Job definitions reviewed; the equivalent commands were executed
locally (see "Final validation").
**Result.** Pass locally; CI execution requires the GitHub runner.

---

## P2-1 — Graceful shutdown, DB/Redis recovery, timeouts

**Issue.** No `SIGTERM`/`SIGINT` handling, no resource cleanup, no HTTP timeouts,
no uncaught-exception policy.
**Files.** `src/utils/errors.js`, `src/utils/mysql.js`, `src/utils/redis.js`,
`src/owo.js`, `index.js`.
**Solution.** Shutdown hook registry with a 5s budget per hook (MySQL pool,
Redis quit, websockets), capped Redis reconnect backoff (`retry_strategy`),
pool error listeners, HTTP timeout on every outbound call, and a sharder-server
retry loop (3 attempts, exponential backoff) at startup.
**Test.** Manual review; `test/http.test.js` covers the timeout path.
**Result.** Pass.

---

## P2-2 — Container support

**Files.** `Dockerfile`, `.dockerignore`, `docker-compose.yml`,
`scripts/healthcheck.js`, `.env.example`.
**Solution.** Multi-stage build (native canvas compiled in the builder, slim
runtime, non-root, `tini`, health check), compose stack with MariaDB (schema
auto-imported) and Redis plus health checks and persistent volumes. Docker
remains optional.
**Test.** Configuration reviewed; health check script executed against closed
ports (`unhealthy`) — it exits 1 as designed.
**Result.** Pass (image build itself needs a Docker host).

---

## P2-3 — License metadata mismatch

**Issue.** `LICENSE` is CC-BY-NC-SA-4.0 while `package.json` declared `ISC`.
**Files.** `package.json`.
**Solution.** Metadata now matches the verified `LICENSE`
(`"license": "CC-BY-NC-SA-4.0"`). The legal text was **not** modified.
**Test.** `package.json` review.
**Result.** Pass.

---

## Pre-existing issues found but intentionally not "fixed"

| Item                                                                                                  | Why                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 7 collectible aliases registered by both `patreon/collectible.js` and `patreon/collectibleClasses.js` | Two parallel implementations; last one loaded wins. Removing either would delete a feature. The loader now logs a warning when an alias is shadowed and `verify:commands` reports them as _known_ shadowing. |
| `mysql@2.18` / `redis@2.8` / `dd-trace@0.31`                                                          | Major upgrades change driver semantics across 87 tables; tracked in SECURITY.md.                                                                                                                             |
| `secret/` contains "secret" files that are public                                                     | Nothing sensitive is inside; documented.                                                                                                                                                                     |
| 742 loose equality comparisons, 63 `var`                                                              | Style debt; `eqeqeq`/`no-var` are a separate, reviewable change.                                                                                                                                             |

---

## Final validation (executed in this environment)

| Command                                | Result                                                                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci --ignore-scripts` (clean copy) | ✅ 500 packages, no SSH credentials required                                                                                            |
| `npm ci` (full, with native canvas)    | ⚠️ not executed here: no cairo/pango toolchain in this sandbox. Provided as a blocking CI job (`native-install`) and by the Dockerfile. |
| `npm run lint`                         | ✅ 0 errors, 0 warnings                                                                                                                 |
| `npm run prettier`                     | ✅ all files formatted                                                                                                                  |
| `npm test`                             | ✅ 59 tests, 0 failures                                                                                                                 |
| `npm run verify:commands`              | ✅ 284 command instances, 522 aliases, 0 problems                                                                                       |
| `npm run audit`                        | ⚠️ 22 advisories (1 critical, 17 high) — documented, none newly introduced                                                              |
| `git diff --check`                     | ✅ no whitespace errors                                                                                                                 |
