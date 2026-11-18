# FIXLOG

## CONNECTION NOT STARTED — the master never delivered eris-sharder's shard assignment (fixed)

Field report with the staged watchdog in place:

```
[BOOT] eris-sharder Master constructed in the worker
[SHARD] plan: cluster 0 -> worker 1, shards 0~0
[ERROR] [GATEWAY] CONNECTION NOT STARTED
[ERROR] The shard assignment (IPC "connect" message) was never received from the master.
```

That isolates the failure to the master → worker hop: the master knew the shard
range (it printed the plan) but the worker never got the message, so no Eris client
was ever constructed and no socket was ever opened.

Why the library can lose it (`node_modules/eris-sharder@1.10.0`):

- `src/sharding/cluster.js:76-96` — a worker creates its Eris client **only** in
  `process.on("message")` on `msg.name === "connect"`.
- `src/sharding/clustermanager.js:139-171` — that message is produced by
  `connectShards()` → `queue.queueItem()` → `queue.emit("execute")` →
  `master.workers[cluster.workerID].send(item.value)`.
- All of it runs inside an async `process.nextTick` in `launch()`, and eris-sharder
  installs only `uncaughtException` on the master — so a `TypeError` on a missing
  `workers[id]`, a closed channel, or a non-serialisable `clientOptions` value
  becomes a **swallowed unhandled rejection**: the queue entry stays put, nothing
  is retried, nothing is logged.

Fix — the master now delivers the assignment itself, verifies it, and never sends a
second copy:

- **new `src/utils/shardAssignment.js`** rebuilds the exact same message from the
  ClusterManager's public state (`id, clusterCount, name:"connect", firstShardID,
lastShardID, maxShards, token, file, clientOptions`), delivers it over the cluster
  channel, reports send failures with their real error/code, and drops
  eris-sharder's stale queue entry once the worker acknowledges.
- **`index.js` `superviseGateway()`** acknowledges via the worker's
  `ipc_connect_received` stage beacon (now carrying `clusterId`), and retries at
  1.5 s / 3 s / 6 s / 12 s / 14 s. A healthy library is never raced: nothing is
  sent while a worker acknowledges, and if another cluster is already connected the
  takeover waits 12 s (eris-sharder serialises clusters on purpose to respect
  Discord's identify concurrency).
- **`[SHARD] plan: … (eris-sharder queue: N pending [ids])`** — a pending entry means
  eris-sharder's own send never happened (the outage), an empty queue with no ack
  means the message left the master but never arrived.
- **No duplicate gateway sessions**: `gatewayBoot` refuses a second `connect()` for
  the same shard range in the same worker (`refused a second gateway connection`),
  and the master removes eris-sharder's queued copy as soon as the worker acks.

Verified by fault injection: with `master.workers[id].send()` disabled in the
installed eris-sharder, the bot now logs
`[CLUSTER] sent the shard assignment for cluster 0 … directly — eris-sharder did not
deliver it (attempt 1)` 1.6 s after boot and the worker proceeds to
`ipc_connect_received → connect_called → [GATEWAY] connecting …`. With the library
restored, no direct send happens (1 and 2 clusters tested), so the workaround only
engages when the library actually fails.

Tests: `test/shardAssignment.test.js` (11, including the "queue never delivers"
regression) — suite 183/183.

## Worker alive, gateway never starts — staged supervisor, IPv4-first DNS, IPC stage beacons

Reported evidence: Node starts, `[DISCORD] authentication successful`, cluster manager
up, worker forked/online, `installed=true` — and then nothing: no `Cluster 0 |
Connecting with 1 shard(s)`, no socket, no HELLO, no IDENTIFY, no READY, no error.
"Worker online" is not "gateway connected", and nothing in the previous build could
tell those two apart.

What was verified against the installed sources and reproduced locally
(Node 22, `DEBUG=true`, `CLUSTERS=2`, fake token):

- **`DEBUG` does not touch the gateway.** `grep config.debug` shows it only forces
  one shard/cluster (`index.js`), limits which guilds are answered
  (`messageCreate.js`, `ready.js`), short-circuits pubsub handlers, and adds error
  stacks. With `DEBUG=true, CLUSTERS=2` run locally, the worker reaches
  `connect()` in 9 ms. So DEBUG is not the cause — the reported log just proves the
  bot was in a restricted dev mode.
- **eris-sharder creates the Eris client only on its IPC `connect` message**
  (`node_modules/eris-sharder/src/sharding/cluster.js:76-96`): the worker's
  `process.on("message")` handles `name === "connect"` and only then calls
  `this.connect(...)` → `new Eris(...)` → `bot.connect()`. If that message is never
  delivered the worker sits idle forever, with **no log line at all**. The master
  side that sends it (`clustermanager.js:151-171`, `connectShards()` →
  `queue.queueItem()` → `master.workers[id].send()`) runs inside an async
  `process.nextTick` where any throw becomes a swallowed unhandled rejection.
- **`Cluster.spawn()` also silently returns** if the shard range is bogus
  (`if (this.shards < 1) return;`), again with no log.

So the previous build had two silent dead-ends _and_ judged liveness from the
process. This pass makes the whole path observable and removes the dead-ends:

1. **Staged supervisor in the worker** (`src/utils/gatewayBoot.js`), driven only by
   real signals: `process_started → sharder_constructed → ipc_connect_received
(process "message" spy) → connect_called (patched Client#connect) →
websocket_open (client "connect") → hello_received / identify_sent /
ready_received (gateway packets)`. Each stage prints `[GATEWAY] stage …`.
2. **IPC stage beacons**: every stage is also sent to the master, which prints
   `[CLUSTER] worker N gateway stage …` — so the timeline survives even if the
   worker's own stdout is lost on the panel.
3. **15 s staged watchdog** (`GATEWAY_CONNECT_TIMEOUT_MS`) printing exactly one of
   `[GATEWAY] CONNECTION NOT STARTED` (+ `[DIAG]` lines naming whether the IPC
   message, the client or `connect()` was missing), `[GATEWAY] WEBSOCKET NOT
OPENED`, or `[GATEWAY] READY TIMEOUT`, followed by the stage table, last packet,
   last error, pid, cluster and elapsed time. A master-side watchdog prints the same
   verdict from the beacons (`CONNECTION NOT STARTED (master view)`).
4. **IPv4-first DNS** (`src/utils/discordDns.js`): `ws` (the gateway) does no Happy
   Eyeballs, so on a host with a broken IPv6 route REST works while the gateway
   hangs silently — the classic "auth successful, never online". The lookup order is
   set to `ipv4first` in every process before any socket opens
   (`GATEWAY_IPV4_FIRST=false` restores `verbatim`), and the boot log prints
   `[BOOT] dns lookup order=…`.
5. **Handshake timeout**: `clientOptions.ws.handshakeTimeout`
   (`GATEWAY_HANDSHAKE_TIMEOUT_MS`, default 20 s) turns a hanging DNS/TCP/TLS
   upgrade into a normal socket error instead of silence.
6. **Gateway probe** (`src/utils/gatewayProbe.js`): a real WebSocket handshake to
   `wss://gateway.discord.gg` that waits for HELLO (op 10) and closes without ever
   sending IDENTIFY, so no session is consumed. Runs at boot (`[GATEWAY] probe`) and
   in `--doctor` (`[ok] gateway websocket — HELLO in 132ms`). It answers the one
   question REST cannot: is the WebSocket path open at all?
7. **No more idle workers**: an empty token or a throwing eris-sharder constructor
   in a worker now logs `[FATAL]` and `process.exit(1)` (the master re-forks and the
   crash-loop detector fires) instead of leaving a healthy-looking process with no
   client. A rejected `connect()` is logged instead of vanishing as an unhandled
   rejection.
8. `[SHARD] plan: cluster 0 → worker 1, shards 0~0` shows what eris-sharder actually
   assigned, and `--doctor` prints the DNS order, the gateway probe, the DEBUG
   explanation, the source fingerprint and the shard/intent/identity checks.

Tests: `test/gatewaySupervisor.test.js` (14). Suite 172/172.

## "Valid token, permanently OFFLINE" — duplicated `Bot ` prefix, no way to prove which source runs

This pass went below the log lines that were already in place and checked what the
installed libraries actually do with the values the panel supplies.

- **The gateway token was prefixed unconditionally.** `index.js` built the sharder
  client with `new Sharder('Bot ' + process.env.BOT_TOKEN, …)`, because Discord's
  docs show the REST header as `Bot <token>`. `src/utils/discordApi.js` meanwhile
  normalised the header (`Bot ` added only if missing), so a panel variable saved
  as `Bot MTIz…` passed every REST check in `--doctor` and still made the socket
  send `Bot Bot MTIz…`, which Discord closes with **4004 Authentication failed**.
  Result: token "valid", clusters up, worker alive, and the bot never online.
  Fix: `src/utils/token.js` (`strip` / `botAuth` / `describeChanges`) is now the
  single place a token becomes a header; `index.js`, `discordApi.js` and the
  doctor's `--connect` login all use it. A modified value is reported as
  `[CONFIG] BOT_TOKEN normalised — …` and as a `[warn] BOT_TOKEN format` row,
  never with the token itself.
- **Packet-level gateway state machine** in `src/utils/gatewayBoot.js`, using only
  APIs that exist in eris 0.17.2: `Shard#sendWS` (IDENTIFY / RESUME / HEARTBEAT)
  and the shard-local `rawWS` event (HELLO, HEARTBEAT_ACK, DISPATCH READY/RESUMED,
  INVALID_SESSION, RECONNECT). States are appended as they are observed —
  `HELLO_RECEIVED → IDENTIFY_SENT → HEARTBEAT_ACKNOWLEDGED → READY_RECEIVED →
BOT_ONLINE → PRESENCE_SYNCHRONIZED` — and printed as `[STATE] …`. A shard READY
  never sets `BOT_ONLINE`; that belongs to the client `ready` event (all shards).
  Nothing is printed as a state that was not actually observed.
- **`rawWS` is shard-local** (eris emits it on the shard, and only when a listener
  exists), so the shards are instrumented right after `connect()` spawns them, and
  again on `shardReady` so a respawned shard is re-traced.
- **Build fingerprint** (`src/utils/buildInfo.js`): sha256 (10 chars) of
  `package.json`, `index.js`, `src/owo.js`, `src/utils/{config,gatewayBoot,presence,readyState,intents,shardConfig}.js`,
  `src/eventHandlers/ready.js`, `src/data/config.json`. Printed at boot
  (`[BOOT] running build …`, and in the worker as `[BOOT] worker … installed=true,
build …`) and by `--doctor` (`[info] source build` + one row per file). This is
  the only way to tell "new code failed" from "old code is still running", which
  a Pterodactyl panel makes very easy to hit (upload ≠ extract ≠ start).
- **Crash context**: `[FATAL]` lines now report how long after READY the process
  died plus the observed gateway timeline, and the master logs
  `[CLUSTER] worker N exited … after Nms` and calls out a worker that dies within
  10 s of fork (`never had time to reach READY`).
- **`--doctor --connect`** reports the real packet timeline in every outcome
  (success, close code, timeout), so a login that stops after HELLO is visible.
- Tests: `test/gatewayStates.test.js` (8), `test/token.test.js` (8). Suite 158/158.

## Root cause of "server RUNNING, bot OFFLINE" — presence inside IDENTIFY

- **eris defaults to `presence.status = "offline"`** (`node_modules/eris/lib/Client.js`) and `Shard#identify` sends that object verbatim (`if (this.presence.status) identify.presence = this.presence`). Upstream only changed it through its private sharder server, so a self-hosted cluster reached READY and still displayed **offline**.
- **The ready handler never ran on the first boot.** eris-sharder loads the application from inside its own `bot.once("ready", …)` (`loadCode`), so any `ready` listener registered by `src/owo.js` is attached after the event fired: no presence, no `bot ready` marker, no health line.
  Fix: `src/utils/readyState.js` + `EventHandler.replayReady()` replay the ready handler once when the cluster loads with `bot.ready === true`.
- **Presence is written before `connect()`** by `src/utils/gatewayBoot.js`, so IDENTIFY itself carries `status: online`; the ready handler then refines it with real guild/user counts and activity templates.
- **Pre-READY visibility**: the same module logs socket open, shard READY, all-shards READY, disconnects with translated close codes and reconnects, plus a READY watchdog (`GATEWAY_READY_TIMEOUT_MS`, default 45s) that prints the last close code and the next step instead of staying silent.
- **Worker lifecycle + crash-loop detection** in `index.js` (`[CLUSTER] worker N forked/online/exited`, crash-loop warning after ≥4 exits in 60s).
- **Missing secret files can no longer crash the cluster**: `src/owo.js` required `tokens/macro.js` → `secret/macro.js` without a last resort and `src/utils/global.js` did the same for `goodwords.json`; both threw at module load, i.e. right after READY, producing a crash loop that looks like "online for a second, then offline". Now `src/utils/macroFallback.js` (documented no-op + loud warning) and empty word lists are used.
- **`--doctor` checks required files** (`tokens|secret/macro.js` exporting `bind`, `badwords.json`, `goodwords.json`) and flags `BOT_STATUS=invisible` as "a healthy bot that looks offline".
- Tests: `test/gatewayBoot.test.js`, `test/readyState.test.js`, extra doctor cases (missing secret files, invalid macro module, invisible status).

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
