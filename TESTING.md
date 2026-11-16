# Testing

## Commands

```bash
npm test                 # unit + regression suite (node:test, no extra deps)
npm run verify:commands   # loads all 284 command modules through the real loader
npm run lint              # ESLint
npm run prettier          # formatting check
npm run checkCircular     # dpdm circular dependency check on src/owo.js
npm run audit             # npm audit --omit=dev
```

`npm ci` must succeed before any of the above (see DEPLOYMENT.md for the native
`canvas` prerequisites).

## Test layout

| File                            | Covers                                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `test/config.test.js`           | env overrides, snowflake validation, empty-owner behaviour, cluster bounds, prefix normalisation                                       |
| `test/auth.test.js`             | owner detection, eval gating, mod-channel + role gates, missing member handling                                                        |
| `test/log.test.js`              | secret redaction, Discord-token redaction, log levels                                                                                  |
| `test/sandbox.test.js`          | eval disabled by default, scope shadowing, output redaction/truncation                                                                 |
| `test/http.test.js`             | the `request` replacement: JSON, binary, `defaults()`, timeouts, non-2xx passthrough, single callback invocation                       |
| `test/mysqlHandler.test.js`     | query timeout option, commit/rollback idempotency, single release, commit failure rollback, lease watchdog, `beginTransaction` failure |
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

It stubs `canvas`, MySQL and Redis so it runs without infrastructure, and exits
explicitly because loading the registry starts timers and pool watchdogs.

## Integration testing (needs infrastructure)

The unit suite deliberately avoids a live database. To exercise the real driver:

```bash
docker compose up -d mariadb redis
MYSQL_HOST=127.0.0.1 REDIS_HOST=127.0.0.1 node --test test/mysqlHandler.test.js
```

## What is _not_ covered yet

- No test drives a real Discord gateway session (requires a bot token).
- Image generation commands (`canvas`) are not asserted pixel-wise.
- The sharder master/cluster lifecycle is not exercised end-to-end.
