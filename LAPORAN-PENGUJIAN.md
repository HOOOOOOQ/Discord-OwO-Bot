# LAPORAN PENGUJIAN — OCEAN BOT (putaran 3: perbaikan sistem menyeluruh)

Diperbarui: putaran 3, branch `arena/bb4e5bbc-discord-owo-bot` (lanjutan `master` `52f715e`).
Semua angka di bawah berasal dari perintah yang **benar-benar dijalankan di repo ini**.
Yang tidak bisa dijalankan di sandbox ditandai **BELUM TERVERIFIKASI** beserta alasannya —
tidak ada hasil yang dibulatkan menjadi "lulus".

## 0. Lingkungan uji

| Hal            | Nilai                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| Node.js        | v22.22.3                                                                                                        |
| Database       | tidak ada MongoDB di sandbox → `MONGO_OFFLINE=true` + `MemoryStore` (adapter asli)                              |
| Jaringan       | sandbox **tidak** bisa menghubungi `discord.com` / `gateway.discord.gg` → READY asli tidak bisa diamati di sini |
| Dependency     | 23 paket produksi; tanpa `mysql`, `redis`, `statsd-client`                                                      |
| Jumlah file JS | 525 (`git ls-files '*.js'`)                                                                                     |

## 1. Hasil pemeriksaan (semua dijalankan)

| #   | Pemeriksaan                     | Perintah                                                      | Hasil                                                                                                                                                                    |
| --- | ------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Syntax seluruh file JS          | `for f in $(git ls-files '*.js'); do node --check "$f"; done` | **PASS** — 525 file, 0 gagal                                                                                                                                             |
| 2   | Dependency konsisten            | `npm ls --depth=0 --omit=dev`                                 | **PASS** — 23 paket, tanpa `extraneous`/`missing`                                                                                                                        |
| 3   | ESLint                          | `npm run lint`                                                | **PASS** — 0 error, 0 warning                                                                                                                                            |
| 4   | Prettier                        | `npx prettier --check "src/**/*.js" "test/**/*.js" index.js`  | **PASS** — semua file sesuai format                                                                                                                                      |
| 5   | Unit + regresi                  | `MONGO_OFFLINE=true npm test`                                 | **PASS** — **264 pass / 0 fail** (13 detik, 34 file test)                                                                                                                |
| 6   | Registrasi command              | `npm run verify:commands`                                     | **PASS** — 285 command, 526 alias, 50 admin, 11 grup, 7 alias shadowed (pre-existing)                                                                                    |
| 7   | Verifikasi database asli        | `npm run verify:db`                                           | **BELUM TERVERIFIKASI** — `MONGODB_URI` tidak ada di sandbox (pesan yang dicetak benar: `[FAIL] MONGODB_URI is not set …`)                                               |
| 8   | Diagnostik startup              | `node index.js --doctor`                                      | 28 pemeriksaan, **2 gagal** (gateway websocket & database) — keduanya karena sandbox tanpa jaringan/kredensial, lihat §4                                                 |
| 9   | Jalur gagal DB saat boot        | 3 skenario (skema salah, koneksi ditolak, URI kosong)         | **PASS** — pesan jelas, `exit 1`, `worker forked = 0` (tidak ada restart loop)                                                                                           |
| 10  | Shutdown graceful               | `node --test test/shutdown.test.js`                           | **PASS** — 4/4 (urutan hook, exit code, hook hang dipotong, handler signal sekali)                                                                                       |
| 11  | Uji gateway + IDENTIFY          | `node --test test/identify.test.js`                           | **PASS** — 4/4 (frame IDENTIFY asli eris: satu `Bot `, intents 130813, presence online/watching)                                                                         |
| 12  | Uji pipeline command end-to-end | `node test/pipeline.test.js`                                  | **PASS** — 9/9 (lihat §2)                                                                                                                                                |
| 13  | Uji SQL→MongoDB                 | `node --test test/sqlEngine.test.js test/sqlParser.test.js`   | **PASS** — 28/28 (termasuk regresi snowflake baru)                                                                                                                       |
| 14  | Konfigurasi presence            | `node index.js --doctor` + `test/presence.test.js`            | **PASS** — `presence — online — watching "discord.gg/666family"`; tampilan di aplikasi Discord: **BELUM TERVERIFIKASI**                                                  |
| 15  | Konfigurasi Pterodactyl         | `pterodactyl/egg-ocean-bot.json`                              | **PASS** — startup `node index.js`, `CLUSTERS=1`, `MONGODB_URI`, `PREFIX=o`, `BOT_STATUS=online`, `BOT_ACTIVITY_TYPE=watching`, `BOT_ACTIVITY_TEXT=discord.gg/666family` |

Catatan jujur soal `--doctor`: dua kegagalan itu **bukan** bug kode.

- `[FAIL] gateway websocket` — sandbox tidak punya rute keluar ke `gateway.discord.gg`.
- `[FAIL] database` — `MONGODB_URI` memang tidak diisi di sini.

Di host Anda kedua baris ini yang harus berubah menjadi `[ok]`.

## 2. Uji pipeline command (baru, tanpa Discord, tanpa Mongo)

`test/pipeline.test.js` memuat **registry command yang asli** (285 command), lalu
mengirim objek message sungguhan ke rantai yang sama dengan produksi:

```
message → Command#execute → checkPrefix → lookup command → gate rules →
initParam → executeCommand → ban/cooldown → CommandInterface#execute → send
```

Database-nya adalah `MemoryStore` di balik adapter MongoDB asli, dan `canvas` di-stub.
Hasil 9/9:

| Test                                         | Yang dibuktikan                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| registry lengkap ≥ 280 command               | loader tidak kehilangan command                                                     |
| `ohelp`                                      | prefix tanpa spasi                                                                  |
| `o help`                                     | prefix + spasi                                                                      |
| `OHELP`, `O HELP`, `OhElP`                   | prefix case-insensitive                                                             |
| `o ping`                                     | command nyata mengirim balasan (`42ms`)                                             |
| `thelp` diabaikan, `owo` tetap mencatat poin | prefix salah tidak memicu apa pun; jalur ekonomi menulis baris `user` lewat adapter |
| `o stats`, `o invite`, `o prefix`            | masing-masing modul asli menjawab, tanpa "something went wrong"                     |
| prefix custom per-guild `!` dari MongoDB     | `!help` dipakai, `o` diabaikan untuk guild itu                                      |
| `o notacommand`                              | **dijawab** sekali, lalu dibatasi (anti-spam)                                       |

## 3. Akar masalah yang dibuktikan dari source (putaran 3)

| #   | Gejala                                                                           | Akar masalah (bukti)                                                                                                                                                                                                                                                                                                                                                          | Perbaikan                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Bot "diam" setelah boot, tanpa error, tanpa Online, proses tetap hidup           | `eris@0.17.2` `Client#connect()` menangkap kegagalan `getGateway()`/`getBotGateway()` lalu mengulang lewat `options.reconnectDelay` dengan `maxReconnectAttempts: Infinity` — tidak ada socket, tidak ada log, tidak ada exit. Dibuktikan dengan probe `process.getActiveResourcesInfo()`: yang menahan event loop adalah `setTimeout` milik `Client.js` (baris 51, 493, 494) | `src/utils/gatewayBoot.js` membungkus `options.reconnectDelay` **sekali per client**: menghitung percobaan, mencatat `[GATEWAY] connect attempt N/limit failed — retrying in Xs (reason)`, dan pada batas (`GATEWAY_CONNECT_ATTEMPTS`, default 6) menulis `[FATAL]` + `[ACTION]` lalu `exit(1)` setelah 50 ms. `patchedConnect` menolak koneksi baru setelah fatal, jadi rekursi eris tidak bisa menahan proses |
| 2   | Dua user berbeda bisa berbagi satu baris data (`count`, `money`) setelah migrasi | Parser SQL mengubah angka **tanpa tanda kutip** menjadi `Number`. Kode lama menyusun SQL dengan konkatenasi (`VALUES (${msg.author.id},1)`), dan `Number('777777777777777777')` = `777777777777777792`. Terbukti: test baru menulis `777777777777777777` lalu membacanya kembali sebagai `...792`                                                                             | `src/utils/mongo/sql/parser.js`: literal bulat di luar `Number.MAX_SAFE_INTEGER` disimpan sebagai string desimal persis (perbandingan & penjumlahan sudah pakai BigInt di `values.js`)                                                                                                                                                                                                                          |
| 3   | `o hlep` / typo apa pun = bot **diam total** (dikira bot mati)                   | `command.js` `dispatch()` hanya `return` ketika `commands[command]` tidak ada                                                                                                                                                                                                                                                                                                 | Balasan ramah `🚫                                                                                                                                                                                                                                                                                                                                                                                               | user, I don't know the command \`x\`. Try \`ohelp\`` dengan pembatas 10 detik per user (maks 5000 entri, dibersihkan otomatis), hanya untuk token yang mirip nama command |
| 4   | `o stats` error di database baru                                                 | `SUM(...)` bernilai `NULL` saat tabel masih kosong → `parseInt(null)` dan `toFancyNum(null)` melempar `Cannot read properties of null`                                                                                                                                                                                                                                        | `stats.js` membaca `SUM`/`COUNT` yang `NULL` sebagai 0                                                                                                                                                                                                                                                                                                                                                          |
| 5   | `o ping` / `o stats` error pada guild yang belum ada di cache                    | `client.shards.get(client.guildShardMap[guildId]).latency` — `guildShardMap` baru terisi setelah `GUILD_CREATE`                                                                                                                                                                                                                                                               | helper baru `src/utils/shardLookup.js` (`shardFor`) yang jatuh ke shard pertama worker; `ping.js` + `stats.js` memakainya                                                                                                                                                                                                                                                                                       |
| 6   | Penulisan poin `owo` tidak bisa ditunggu/diuji, promise menggantung              | `executeCommand(...)` dipanggil tanpa `await` pada jalur points & rules                                                                                                                                                                                                                                                                                                       | `dispatch()` men-`await` ketiga jalur tersebut (tetap dibungkus `errors.runCommandSafely`, jadi error tidak keluar)                                                                                                                                                                                                                                                                                             |
| 7   | "Stop" dari panel bisa menggantung                                               | timeout hook shutdown 5 detik tetap _ref'd_ walau hook selesai, dan tidak bisa diubah                                                                                                                                                                                                                                                                                         | `SHUTDOWN_HOOK_TIMEOUT_MS` bisa diatur; timer pemotong dibersihkan begitu hook selesai                                                                                                                                                                                                                                                                                                                          |
| 8   | MongoDB lokal tanpa password ditolak pre-flight                                  | validasi hanya menerima URI dengan `user:pass`                                                                                                                                                                                                                                                                                                                                | host loopback (`localhost`/`127.0.0.1`/`::1`) diizinkan dengan peringatan eksplisit; host lain tetap wajib kredensial                                                                                                                                                                                                                                                                                           |
| 9   | Tidak ada kategori log `[COMMAND]`                                               | semua kegagalan command tercetak `[ERROR]`                                                                                                                                                                                                                                                                                                                                    | `errors.logFailure` memberi tag `[COMMAND]` bila `meta.command`/`meta.stage` berasal dari command; sisanya `[ERROR]`                                                                                                                                                                                                                                                                                            |

Kategori log yang dipakai kode (dapat di-grep): `[BOOT]`, `[CONFIG]`, `[DISCORD]`,
`[GATEWAY]`, `[SHARD]`, `[DATABASE]`/`[MONGO]`, `[COMMAND]`, `[ERROR]`, `[STATE]`,
`[HEALTH]`. Token & password selalu di-mask (`mongodb://***@host/db`).

## 4. Yang BELUM TERVERIFIKASI (butuh akses Anda)

| Hal                                                        | Kenapa                                                                       | Cara memastikan di host                                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| READY asli + status **Online**                             | sandbox tanpa rute ke `gateway.discord.gg` (hanya diuji dengan socket palsu) | jalankan bot, tunggu `[STATE] BOT_ONLINE` dan `[HEALTH] OCEAN IS ONLINE`            |
| Activity `Watching discord.gg/666family`                   | sama                                                                         | lihat profil bot di Discord                                                         |
| Reconnect nyata (disconnect 4000/1006 lalu pulih)          | butuh sesi gateway asli                                                      | restart jaringan host / tunggu `[GATEWAY] connect attempt …` muncul lalu READY lagi |
| Tombol **Join Community**                                  | butuh Discord                                                                | `ohelp`, klik tombol                                                                |
| Baca/tulis Atlas asli                                      | butuh `MONGODB_URI` Anda                                                     | bot **stop**, lalu `MONGODB_URI='mongodb+srv://…' npm run verify:db`                |
| Ekonomi/inventory/battle/giveaway/quest/XP pada data nyata | sama                                                                         | `verify:db` menulis dengan ID `999999999999999999` lalu menghapusnya                |
| Tampilan gambar (`canvas`)                                 | butuh `cairo`/`pango` di host                                                | pakai `npm ci` penuh di panel, lalu `o profile`                                     |

## 5. Bukti jalur gagal (dijalankan nyata)

```
BOT_TOKEN='Bot MTIz.abc.def' MONGODB_URI='mongodb://127.0.0.1:27099/ocean?serverSelectionTimeoutMS=800' \
MONGODB_CONNECT_ATTEMPTS=1 node index.js
  WARN  [MONGO] connecting to a loopback MongoDB without credentials — only valid for a local mongod started without --auth
  ERROR [MONGO] connection attempt 1/1 failed: connect ECONNREFUSED 127.0.0.1:27099
  ERROR [MONGO] could not connect to mongodb://***@127.0.0.1:27099/ocean after 1 attempt(s)
  ERROR [ACTION] Atlas → Network Access: allow 0.0.0.0/0 …
  ERROR [MONGO] MongoDB connection failed: connect ECONNREFUSED 127.0.0.1:27099
  ERROR [FATAL] MongoDB is the only datastore — … exiting with code 1, no restart loop
  → exit code 1, tanpa worker fork

BOT_TOKEN=FAKE MONGODB_URI='mysql://x'   → ERROR [MONGO] unsupported scheme "mysql" → exit 1
BOT_TOKEN=FAKE MONGODB_URI=''            → ERROR [MONGO] MONGODB_URI is not set → exit 1
```

Batas percobaan gateway juga diuji tanpa jaringan (`test/identify.test.js` test 4):
`reconnectDelay` dipanggil ulang → `[GATEWAY] connect attempt 1..3/2 failed` →
`[FATAL]` → `process.exit(1)` dipanggil (di-inject pada test, bukan proses uji).

## 6. File yang diubah pada putaran 3

| File                                                   | Perubahan                                                                                             |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `src/utils/gatewayBoot.js`                             | pelapor percobaan koneksi sekali-per-client, `[FATAL]` + exit, `fatalConnectFailure`, ringkasan tahap |
| `src/utils/mongo/sql/parser.js`                        | literal angka besar tetap presisi (snowflake)                                                         |
| `src/commands/command.js`                              | balasan unknown-command + anti-spam, `await` jalur points/rules                                       |
| `src/utils/shardLookup.js`                             | **baru** — pencarian shard yang aman                                                                  |
| `src/commands/commandList/utils/ping.js`, `…/stats.js` | pakai `shardFor`; `stats` tahan `NULL`                                                                |
| `src/utils/errors.js`                                  | tag `[COMMAND]`, `SHUTDOWN_HOOK_TIMEOUT_MS`, pembersihan timer                                        |
| `src/utils/mongo/client.js`                            | host loopback tanpa kredensial diizinkan + peringatan                                                 |
| `test/identify.test.js`                                | **baru** — 4 test gateway/IDENTIFY                                                                    |
| `test/pipeline.test.js`                                | **baru** — 9 test rantai command penuh                                                                |
| `test/shutdown.test.js`                                | **baru** — 4 test shutdown graceful                                                                   |
| `test/sqlEngine.test.js`                               | +1 regresi snowflake tanpa tanda kutip                                                                |

## 7. Cara menjalankan

```
BOT_TOKEN=xxxx
MONGODB_URI=mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/ocean
MONGODB_DB=ocean
PREFIX=o
CLUSTERS=1
DEBUG=false
BOT_STATUS=online
BOT_ACTIVITY_TYPE=watching
BOT_ACTIVITY_TEXT=discord.gg/666family
```

Startup command: `node index.js` · Node 20/22 · RAM 1 GB cukup, 2 GB nyaman ·
tanpa MySQL/MariaDB/Redis/InfluxDB/Neo4j.

Verifikasi di host (bot **stop** untuk `verify:db`):

```
node index.js --doctor
npm run verify:commands
MONGODB_URI='mongodb+srv://…' npm run verify:db
node index.js
```

Lalu di Discord: `ohelp`, `o help`, `OHELP`, `o ping`, `o stats`, `o invite`,
`o prefix`, `o profile`, `o daily`, `o hunt`, `o battle`, `o salahketik`
(harus dijawab "I don't know the command …").

Panduan lengkap: [README.id.md](README.id.md) · Pterodactyl: [PTERODACTYL.md](PTERODACTYL.md).
