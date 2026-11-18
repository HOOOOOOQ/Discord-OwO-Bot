# LAPORAN PENGUJIAN — OCEAN BOT (MongoDB-only)

Diperbarui: putaran verifikasi terakhir pada branch `arena/2d14b81c-discord-owo-bot`.
Semua angka di bawah adalah hasil perintah yang benar-benar dijalankan di repo ini,
bukan perkiraan. Yang tidak bisa dijalankan ditandai **BELUM TERVERIFIKASI**
beserta alasannya.

## 0. Lingkungan uji

| Hal | Nilai |
| --- | --- |
| Node.js | v22.22.3 |
| Database | tidak ada MongoDB di sandbox uji → dipakai `MONGO_OFFLINE=true` + `MemoryStore` |
| Jaringan | sandbox **tidak** bisa menghubungi `discord.com` → READY asli tidak bisa diamati di sini |
| Dependency | 23 paket produksi, tanpa `mysql`, `redis`, `statsd-client` |

## 1. Matriks 15 pemeriksaan

| # | Pemeriksaan | Perintah | Hasil |
| --- | --- | --- | --- |
| 1 | Syntax seluruh file JS | `for f in $(git ls-files '*.js'); do node --check $f; done` | **PASS** — 523 file, 0 gagal |
| 2 | Dependency terpasang benar | `npm ls --depth=0 --omit=dev` | **PASS** — 23 paket, tidak ada `extraneous`/`missing`, tanpa mysql/redis/statsd-client |
| 3 | `package-lock.json` sesuai `package.json` | bandingkan `lock.packages[""].dependencies` | **PASS** — 23/23 sama, `lockfileVersion: 3` |
| 4 | Syntax check ulang setelah patch | `node --check` tiap file yang diubah | **PASS** |
| 5 | ESLint | `npm run lint` | **PASS** — 0 error, 0 warning |
| 6 | Unit test | `MONGO_OFFLINE=true npm test` | **PASS** — **246 pass / 0 fail** (7,4 s) |
| 7 | Verifikasi registrasi command | `MONGO_OFFLINE=true node scripts/verifyCommands.js` | **PASS** — 285 command, 526 alias, 50 admin, 11 grup, 7 alias shadowed (pre-existing) |
| 8 | Verifikasi database asli | `npm run verify:db` | **BELUM TERVERIFIKASI** — butuh `MONGODB_URI` Atlas Anda; jalankan di host dengan bot **stop** |
| 9 | Prefix parser | `node --test test/prefix.test.js` | **PASS** — 12/12 (`ohelp`, `o help`, `O HELP`, prefix custom, prefix salah ditolak) |
| 10 | MongoDB adapter | `node --test test/kv.test.js test/sqlEngine.test.js test/sqlParser.test.js test/mysqlHandler.test.js` | **PASS** — 9 + 20 + 7 + 8 test |
| 11 | Registrasi command (isi & alias) | sama dengan #7 + `test/commandRegistry.test.js` | **PASS** |
| 12 | Lifecycle gateway | `node --test test/gatewayBoot.test.js test/gatewayStates.test.js test/gatewaySupervisor.test.js test/shardAssignment.test.js test/readyState.test.js` | **PASS** — 42/42 (unit). READY asli: **BELUM TERVERIFIKASI** |
| 13 | Konfigurasi presence | `node --test test/presence.test.js` + `node index.js --doctor` | **PASS** — `presence — online — watching "discord.gg/666family"`; tampilan di Discord: **BELUM TERVERIFIKASI** |
| 14 | Konfigurasi Pterodactyl | baca `pterodactyl/egg-ocean-bot.json` | **PASS** — JSON valid, startup `node index.js`, variabel `MONGODB_URI`, `MONGODB_DB=ocean`, `PREFIX=o`, `CLUSTERS=1`, `DEBUG=false`, `BOT_STATUS=online`, `BOT_ACTIVITY_TYPE=watching`, `BOT_ACTIVITY_TEXT=discord.gg/666family` |
| 15 | Jalur gagal saat boot | 3 skenario URI buruk (lihat §3) | **PASS** — pesan jelas, `exit 1`, tidak ada worker fork |

Bukti tambahan:

- `node index.js --doctor` → `28 checks, 1 failed, 5 warning(s)`. Satu-satunya
  yang gagal adalah **gateway websocket** (sandbox tidak punya akses ke
  `gateway.discord.gg`); token pun tidak bisa divalidasi karena alasan yang sama.
- `MONGO_OFFLINE=true node scripts/verifyCommands.js` selesai tanpa hang
  (dulu proses menggantung karena timer `animalInfoUtil`).

## 2. Yang diperbaiki pada putaran ini

| # | Masalah | Perbaikan |
| --- | --- | --- |
| 1 | `statsd-client` membuat socket ke `localhost:9125` setiap boot | client tidak dibuat lagi kecuali `METRICS_ENABLED=true`; dependency dihapus dari `package.json` + lockfile |
| 2 | Logger menembak `${INFLUXDB_HOST}/command` walau host kosong → warning `InfluxDB is inactive` berulang | `postInflux()` berhenti total bila `INFLUXDB_HOST` kosong; warning tidak muncul lagi (InfluxDB tidak dipakai) |
| 3 | `kv.js` memakai `getStore()` yang **throw** bila koneksi belum siap | sekarang `await client.whenReady()` — command yang jalan saat boot menunggu, tidak meledak |
| 4 | `o help` / `o invite` hanya menampilkan link di teks | ditambah tombol link **Join Community** (style 5) ke `https://discord.gg/666family`; link invalid → embed dikirim tanpa komponen (tidak ditolak Discord) |
| 5 | `animalInfoUtil.initialize()` + `cacheUtil` memakai timer *ref'd* → proses tidak pernah exit, retry tiap 5 s saat DB down | semua timer `unref()`; test `--doctor`/`healthcheck`/`npm test` tidak menggantung lagi |
| 6 | Default `CLUSTERS=60` (OOM di panel 2 GB) | default sekarang **1** (`src/data/config.json`, `config.js`, egg, docs); `CLUSTERS` eksplisit tetap menang |
| 7 | Egg Pterodactyl: `CLUSTERS=2`, activity `playing` / `o help` | default `1`, `watching`, `discord.gg/666family` |
| 8 | Tidak ada jaring pengaman untuk regresi "layanan ekstra" | test baru `test/platform.test.js` (7 test): tidak ada HTTP ke Influx saat kosong, tidak ada socket localhost, KV menunggu Mongo, tombol komunitas, presence dipasang ulang saat resume |

Sudah ada dari putaran sebelumnya (tetap berlaku, tetap diuji): pre-flight
MongoDB di `index.js` sebelum gateway dibuka, SQL→MongoDB engine, KV pengganti
Redis, URI divalidasi & di-mask, `ohelp`/`o help`, presence setelah READY.

## 3. Bukti jalur gagal (dijalankan nyata)

```
BOT_TOKEN=FAKE MONGODB_URI='mysql://x' node index.js
  ERROR [MONGO] MONGODB_URI uses an unsupported scheme "mysql:" …
  ERROR [FATAL] MongoDB is the only datastore — … exiting with code 1, no restart loop
  → exit code 1

BOT_TOKEN=FAKE MONGODB_URI='mongodb://u:p@127.0.0.1:27017/ocean' MONGODB_CONNECT_ATTEMPTS=1 node index.js
  ERROR [MONGO] connection attempt 1/1 failed: connect ECONNREFUSED 127.0.0.1:27017
  ERROR [MONGO] could not connect to mongodb://***@127.0.0.1:27017/ocean after 1 attempt(s)
  ERROR [ACTION] Atlas → Network Access: allow 0.0.0.0/0 …
  → exit code 1, "worker 1 forked" = 0 kali (tidak ada restart loop)

BOT_TOKEN=FAKE MONGODB_URI='' node index.js
  ERROR [MONGO] MONGODB_URI is not set. Pterodactyl → Startup → add MONGODB_URI …
  → exit code 1
```

Password tidak pernah tercetak (`mongodb://***@…`).

## 4. Yang BELUM TERVERIFIKASI (butuh akses Anda)

| Hal | Kenapa | Cara mengetes di host |
| --- | --- | --- |
| READY asli + status Online | sandbox tanpa akses `gateway.discord.gg` | Start bot, tunggu baris `[STATE] BOT_ONLINE` dan `[HEALTH] OCEAN IS ONLINE` |
| Activity `Watching discord.gg/666family` | sama | lihat profil bot di Discord |
| Tombol **Join Community** | perlu Discord | `ohelp`, klik tombolnya |
| Baca/tulis database asli | butuh `MONGODB_URI` Anda | bot **stop**, lalu `MONGODB_URI='mongodb+srv://…' npm run verify:db` |
| Ekonomi/inventory/battle/giveaway/quest/XP pada data nyata | sama | `verify:db` menulis dengan ID palsu `999999999999999999` lalu menghapusnya |

`scripts/verifyDatabase.js` mencetak `n/n checks passed` dan `exit 1` bila ada
yang gagal, jadi hasilnya tidak bisa "dibulatkan" jadi PASS.

## 5. Cara menjalankan (ringkas)

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

Panduan lengkap: [README.id.md](README.id.md) · Pterodactyl: [PTERODACTYL.md](PTERODACTYL.md).
