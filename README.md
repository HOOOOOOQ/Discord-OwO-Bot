# OCEAN

[![Discord Bots](https://discordbots.org/api/widget/status/408785106942164992.svg)](https://discordbots.org/bot/408785106942164992) [![Discord Bots](https://discordbots.org/api/widget/servers/408785106942164992.svg)](https://discordbots.org/bot/408785106942164992) [![Discord Bots](https://discordbots.org/api/widget/lib/408785106942164992.svg)](https://discordbots.org/bot/408785106942164992)

**OCEAN** is a self-hostable Discord bot for animal collection, cowoncy economy and
team battles — a rebranded fork of [OwO Bot](https://github.com/ChristopherBThai/Discord-OwO-Bot)
by ChristopherBThai (see [License](#license); the original attribution is kept).

Default prefix: **`o`**. Override the default with the `PREFIX` environment variable,
or per server with `o prefix <new prefix>` (requires **Manage Channels**).
Full command list: [COMMANDS.md](COMMANDS.md).

Extra feature: restricted cowoncy grants — `o grant @user 1000` — usable by the
bot owners plus any users/roles listed in `COWONCY_ADMIN_IDS` /
`COWONCY_ADMIN_ROLE_IDS` (see [DEPLOYMENT.md](DEPLOYMENT.md#cowoncy-grants-grant)).

## Self hosting

Requirements: **Node.js ≥ 20**, **MariaDB/MySQL**, **Redis**, and a native
toolchain (`build-essential python3 libcairo2-dev libpango1.0-dev libjpeg-dev
libgif-dev librsvg2-dev`) for the `canvas` dependency.

```bash
cp .env.example .env      # add your BOT_TOKEN, OWNER_IDS, MySQL/Redis settings
npm ci
npm run verify:commands   # loads every command module
node index.js
```

There is **no default owner**: set `OWNER_IDS` to your Discord user id, otherwise
all owner-only commands (including `eval`) stay disabled. `DEBUG` defaults to
`false`.

Docker (bot + MariaDB + Redis) is available but optional:

```bash
cp .env.example .env && docker compose up -d --build
```

Full instructions: [DEPLOYMENT.md](DEPLOYMENT.md). Security posture and residual
risks: [SECURITY.md](SECURITY.md). Tests: [TESTING.md](TESTING.md). Repair log
with root causes and verification: [FIXLOG.md](FIXLOG.md). Architecture and
remaining technical debt: [ANALISIS.md](ANALISIS.md).

The bot uses [MariaDB](https://mariadb.org/) and [Redis](https://redis.io/) for
its databases. Some files may be missing due to security reasons and can be
found [here](https://github.com/ChristopherBThai/Discord-OwO-Bot/tree/master/secret).

## Testing

```bash
npm test                  # unit + regression suite (node:test)
npm run lint              # ESLint
npm run prettier          # Prettier check
npm run audit             # production dependency audit
```

## License

OwO Bot is licensed under the terms of [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International](https://github.com/ChristopherBThai/Discord-OwO-Bot/blob/master/LICENSE) ("CC-BY-NC-SA-4.0"). Commercial use is not allowed under this license. This includes any kind of revenue made with or based upon the software, even donations.

The CC-BY-NC-SA-4.0 allows you to:

- [x] **Share** -- copy and redistribute the material in any medium or format
- [x] **Adapt** -- remix, transform, and build upon the material

Under the following terms:

- **Attribution** — You must give appropriate credit, provide a link to the license, and indicate if changes were made. You may do so in any reasonable manner, but not in any way that suggests the licensor endorses you or your use.
- **NonCommercial** — You may not use the material for commercial purposes.
- **ShareAlike** — If you remix, transform, or build upon the material, you must distribute your contributions under the same license as the original.

More information can be found [here](https://creativecommons.org/licenses/by-nc-sa/4.0/).

## Contributing

All merge requests are welcome! Just make sure to sign the [CLA](https://cla-assistant.io/ChristopherBThai/Discord-OwO-Bot) or else we cannot merge your changes.
