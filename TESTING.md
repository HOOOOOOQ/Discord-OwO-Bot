# Testing

## Commands

```bash
MONGO_OFFLINE=true npm test   # unit + regression suite (node:test, no database needed)
npm run verify:commands   # loads all 285 command instances through the real loader
npm run verify:db         # live MongoDB read/write check (needs MONGODB_URI)
npm run lint              # ESLint
npm run prettier          # formatting check
npm run checkCircular     # dpdm circular dependency check on src/owo.js
npm run audit             # npm audit --omit=dev
```

`npm ci` must succeed before any of the above (see DEPLOYMENT.md for the native
`canvas` prerequisites). Always set `MONGO_OFFLINE=true` for offline runs: a few
modules touch the Mongo client at require-time and would otherwise try to
connect. **Result of the last full run: 239 pass / 0 fail.**

## Test layout

| File                            | Covers                                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `test/config.test.js`           | env overrides, snowflake validation, empty-owner behaviour, cluster bounds, prefix normalisation                                       |
| `test/auth.test.js`             | owner detection, eval gating, mod-channel + role gates, missing member handling                                                        |
| `test/log.test.js`              | secret redaction, Discord-token redaction, log levels                                                                                  |
| `test/sandbox.test.js`          | eval disabled by default, scope shadowing, output redaction/truncation                                                                 |
| `test/http.test.js`             | the `request` replacement: JSON, binary, `defaults()`, timeouts, non-2xx passthrough, single callback invocation                       |
| `test/mysqlHandler.test.js`     | query timeout option, commit/rollback idempotency, single release, commit failure rollback, lease watchdog, `beginTransaction` failure |
| `test/sqlParser.test.js`        | 34 real statement shapes from the command tree: tokenizer, multi-statement split, aliases, `ON DUPLICATE KEY` parsing, rejections    |
| `test/sqlEngine.test.js`        | `INSERT IGNORE`, duplicate-key errors, atomic `$inc` for `ON DUPLICATE KEY UPDATE` (25 parallel increments), AUTO_INCREMENT/insertId, INNER vs LEFT JOIN, `UPDATE ... JOIN`, multi-table DELETE, COUNT/SUM/MAX/GROUP BY, subqueries, `TIMESTAMPDIFF`, `REPLACE INTO`, generated columns, snowflake PKs |
| `test/kv.test.js`               | the Redis replacement: hashes, `hincrby`, sorted sets (XP/ranking), sets, TTL expiry, purge, and prefix persistence across a simulated restart |
| `test/migration.test.js`        | no `require('mysql')`/`require('redis')`, no such dependencies in `package.json`/lockfile, no legacy env reads, URI validation + masking, presence defaults, guild link |
| `test/doctor.test.js`           | MongoDB storage checks: healthy env, missing/invalid URI, SQL URL rejection, legacy variable warnings                                                                  |
| `test/presence.test.js`         | status/activity resolution, `{guilds}` placeholder, refresh behaviour, watching default                                                                                |
| `test/gatewayBoot.test.js`      | intent resolution and gateway readiness guards                                                                                                                         |
| `test/commandInterface.test.js` | permission check, NSFW gate, `this` binding, single error reply per invocation                                                         |
| `test/commandRegistry.test.js`  | registry analysis: duplicate aliases, documented shadowing, counts, alias integrity after the repairs                                  |
| `test/urbanDictionary.test.js`  | callback contract of the replacement client, `NOT_FOUND`, empty input                                                                  |
| `test/translate.test.js`        | translation response parsing, language table, empty input                                                                              |
| `test/mathResult.test.js`       | timeout classification (regression for the `1000 ms` mismatch)                                                                         |

## Full-registry verification

`npm run verify:commands` requires every file under
`src/commands/commandList` through the same `require-dir` loader the bot uses,
then asserts:

- every export is a `CommandInterface`,
- no alias is registered twice (7 known collectible aliases are reported as
  pre-existing shadowing, documented in FIXLOG.md),
- aliases are non-empty and lowercase,
- command instances and total alias count are in the expected range.

It stubs `canvas` and the database facades so it runs without infrastructure,
and exits explicitly because loading the registry starts timers and watchdogs.
Last run: **285 command instances, 526 unique aliases, 50 admin commands,
11 groups, 7 known shadowed aliases**.

## Integration testing (needs infrastructure)

The unit suite runs entirely in memory (`MemoryStore`). To exercise a real
cluster, use an Atlas free tier and run the verification script **with the bot
stopped**:

```bash
export MONGODB_URI='mongodb+srv://user:pass@cluster0.abcde.mongodb.net/ocean'
node scripts/verifyDatabase.js
```

It writes under the fake ids `999999999999999999` / `999999999999999998`, checks
economy, inventory, weapons, battle expiry, quests, giveaways, XP/ranking,
per-server prefix, cooldowns, closes and reopens the client to prove
persistence, then deletes every test row (also on crash). Exit code 1 on any
failure.

For the full stack: `docker compose up -d mongo` (commented service) and
`MONGODB_URI=mongodb://127.0.0.1:27017/ocean npm run verify:db`.

## What is _not_ covered yet

- No test drives a real Discord gateway session (requires a bot token).
- Image generation commands (`canvas`) are not asserted pixel-wise.
- The sharder master/cluster lifecycle is not exercised end-to-end.
- A real Discord READY cannot be asserted inside CI (no token / no gateway
  access); it is verified manually with `node index.js --doctor --connect` or by
  starting the bot and reading `[STATE] BOT_ONLINE`.
