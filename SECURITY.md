# Security Policy & Hardening Notes

## Reporting a vulnerability

Open a private security advisory on the repository, or contact the maintainer
listed in `package.json`. Please do not open a public issue for an exploitable
problem.

## Threat model of this codebase

OwO Bot is a long-running, multi-process Discord bot (~60 sharder clusters per
host) that talks to Discord, MariaDB, Redis and a handful of internal HTTP
services. The relevant attacker is:

1. a Discord user who can send commands to the bot (untrusted input),
2. a server admin who can configure the bot's prefix/roles (semi-trusted),
3. an operator who can read the process environment (fully trusted).

## Security controls in this repository

### 1. Privileged identities never ship in the defaults

`src/data/config.json` ships **empty** `owners`, `role.*`, `modChannels`.
Authorization is resolved by `src/utils/config.js` from environment variables
(`OWNER_IDS`, `ADMIN_ROLE_IDS`, `MOD_CHANNEL_IDS`, ...) and validated as Discord
snowflakes. An empty owner list **denies** owner commands instead of granting
them; there is no fallback to a hardcoded id.

Consequence for forks: an instance that forgets to set `OWNER_IDS` has **no**
owner, not the original author as owner.

### 2. Owner-only dynamic evaluation is off by default

`eval` and `broadcastEval` keep their original mechanism but are gated:

- `ALLOW_EVAL=true` is required (default false),
- the caller must be listed in `OWNER_IDS`,
- each invocation is audited (`audit action=eval ...`),
- `require`, `process`, `module`, `exports`, `Buffer` and `globalThis` are
  shadowed inside the evaluation scope,
- output is passed through the secret redactor and length-capped before it is
  sent to Discord.

This is defence in depth, **not** a sandbox: JavaScript cannot sandbox itself and
`Function`-constructor escapes remain possible. The real control is that the
feature is disabled unless an operator explicitly enables it.

### 3. SQL access

- Every user-supplied value is passed as a query parameter; the interpolated
  statements that were reachable from user input were converted
  (`acceptedRules`, `rep`, `user_ring`, `autohunt`).
- `multipleStatements` is **still enabled by default** because existing battle
  and zoo queries send several statements per call
  (`battle/ab.js`, `battle/db.js`, `zoo/sacrifice.js`, `teamUtil.js`,
  `WeaponInterface.js`). Set `MYSQL_MULTIPLE_STATEMENTS=false` once those call
  sites are migrated; until then run the bot's database user with the minimum
  privileges it needs (no `DROP`, no `FILE`, no cross-schema access).
- Queries carry a client-side timeout (`MYSQL_QUERY_TIMEOUT_MS`), transactions
  have a lease watchdog and always release their connection.

### 4. Secrets

- No credentials are committed. `.env` is git-ignored; `secret/env` is a
  placeholder template.
- The structured logger redacts any environment value whose key looks secret
  (`*TOKEN`, `*PASS*`, `*SECRET*`, `*_KEY`) and any Discord-shaped token. This
  applies to `console.*` as well, because those calls are bridged through
  `src/utils/log.js`.

### 5. Process robustness as a security property

An unhandled rejection used to be able to kill a cluster (and, before that, to
take the whole shard down repeatedly). Every gateway handler, command
invocation and HTTP callback is now wrapped, `uncaughtException` triggers a
graceful shutdown, and pool/connection `error` events have listeners.

## Known, documented residual risks

| Item                                                     | Why it is still open                                                | Mitigation                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `tar` (critical) via `canvas@2` → `@mapbox/node-pre-gyp` | Fixed only in `canvas@3`, a breaking change for every image command | Not reachable from untrusted input (build-time tooling); track for a canvas 3 migration |
| `dd-trace@0.31` (high, EOL)                              | Major upgrade to 6.x changes APM behaviour                          | Only initialised outside debug mode; upgrade scheduled                                  |
| `redis@2.8` (high, EOL)                                  | Same reason: v4 changes the client API used everywhere              | Redis is on a private network; upgrade scheduled                                        |
| `patreon`, `patreon-discord` (high, abandoned)           | Upstream SDK abandoned                                              | Optional integration, disabled without credentials                                      |
| `mathjs@6` (high, prototype pollution)                   | Engine is shared by `owo math`; v6→v15 is a large jump              | Expression evaluation runs in a sandboxed worker with import/createUnit/parse disabled  |
| `mysql@2.18` (deprecated)                                | `mysql2` has subtle type/date differences across 87 tables          | Parameterized queries + query timeouts added; migration tracked in FIXLOG               |
| `multipleStatements: true`                               | Required by existing multi-statement queries                        | See §3                                                                                  |

Run `npm run audit` for the current, authoritative list.
