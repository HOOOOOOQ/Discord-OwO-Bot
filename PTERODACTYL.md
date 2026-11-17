# Deploy OCEAN ke Pterodactyl

Panduan ini memasang **OCEAN** (fork OwO Bot) sebagai server di panel
**Pterodactyl 1.x** (panel + Wings, image Docker).

Ringkas: Pterodactyl menjalankan bot di dalam container dengan volume
`/home/container`, dan **image resmi `nodejs_20` tidak bisa dipakai apa adanya**
karena tidak punya library native untuk `canvas`. Karena itu langkah pertamanya
membangun satu image kecil turunan dari image resmi Pterodactyl.

Dua file di repo ini dipakai:

| File                             | Fungsi                                                        |
| -------------------------------- | ------------------------------------------------------------- |
| `pterodactyl/Dockerfile`         | Image Node.js 20 + library canvas (cairo/pango/…)             |
| `pterodactyl/egg-ocean-bot.json` | Egg siap import (startup `node index.js`, installer `npm ci`) |

---

## 0. Prasyarat

- Pterodactyl **1.x** (panel + Wings) yang sudah jalan.
- Node.js **20** di image (sudah disediakan), Docker di node Wings.
- **MariaDB 10.6+ / MySQL 8** dan **Redis 6+** — boleh di host yang sama dengan
  Wings, tapi **bukan** di dalam container bot (lihat bagian 5).
- RAM server: **≥ 1.5 GB** (disarankan 2 GB), disk **≥ 3 GB** (node_modules dan
  hasil kompilasi canvas cukup besar).
- Allocation/port apa pun boleh (bot tidak listening ke port; port hanya syarat
  administratif Pterodactyl).

---

## 1. Build & push image

Jalankan di host yang punya Docker (biasanya node Wings):

```bash
cd pterodactyl
# ganti USER dengan akun GitHub/Docker Hub kamu
docker build -t ghcr.io/USER/ocean-bot:node20 .
docker push ghcr.io/USER/ocean-bot:node20
```

Kalau memakai Docker Hub:

```bash
docker build -t docker.io/USERNAME/ocean-bot:node20 .
docker login
docker push USERNAME/ocean-bot:node20
```

> Wings akan menarik image dari registry, jadi image **harus di-push**, bukan
> hanya di-build lokal. Untuk registry privat, login Docker di node Wings dulu
> (`docker login`), atau jadikan publik.

Isi image: `ghcr.io/pterodactyl/yolks:nodejs_20` (Alpine, punya `entrypoint.sh`
dan user `container`) + `cairo pango jpeg giflib librsvg pixman` (runtime),
`build-base python3 pkgconf` + `*-dev` (kompilasi `canvas`), `ttf-dejavu`
(font meme). Tidak ada source code di dalam image.

---

## 2. Import egg

1. Panel → **Admin → Nests** → buat nest baru, mis. `bots`.
2. **Import Egg** → pilih `pterodactyl/egg-ocean-bot.json`.
3. Sebelum (atau sesudah) import, buka egg itu dan **ganti** semua nilai
   `ghcr.io/USER/ocean-bot:node20` dengan image hasil langkah 1. Ada di dua
   tempat: **Docker Images** dan **Install Script → container**.

---

## 3. Buat server

- Nest/egg: `OCEAN Bot`.
- Allocation: pilih satu (tidak dipakai bot).
- **Memory: 2048 MB**, disk 3072 MB (boleh lebih).
- Startup command (sudah dari egg): `node index.js`.
- Tab **Startup/Variables**:

| Variable    | Nilai         | Catatan                                                               |
| ----------- | ------------- | --------------------------------------------------------------------- |
| `CLUSTERS`  | `2`           | **Jangan** biarkan 60 (default repo) di panel kecil → OOM. 1–2 cukup. |
| `PREFIX`    | `o`           | Prefix default. Bisa diubah per server: `o prefix <baru>`.            |
| `OWNER_IDS` | id Discord-mu | Kosong = tidak ada owner, `eval` dan command owner lain mati.         |

Variable panel dikirim sebagai environment variable dan **menang** atas isi
`.env` (dotenv tidak menimpa env yang sudah ada).

---

## 4. Upload source code

Bot harus ada di volume `/home/container`:

- Cara termudah dari mesin lokal:

  ```bash
  git clone https://github.com/HOOOOOOQ/Discord-OwO-Bot.git ocean-bot
  cd ocean-bot
  rm -rf .git node_modules
  zip -r ocean-bot.zip .
  ```

  lalu upload `ocean-bot.zip` lewat **File Manager** dan extract, **atau**
  upload lewat SFTP (kredensial ada di tab _SFTP Details_).

- Yang wajib ada: `index.js`, `src/`, `utils/`, `secret/`, `package.json`,
  `package-lock.json`, `.env.example`.
- **Jangan** upload `node_modules` (akan dibuat ulang oleh installer).

Setelah file ter-upload: tekan **Reinstall Server**. Installer egg menjalankan
dua hal — persis yang kamu butuhkan kalau startup command di panel dikunci ke
`index.js`:

1. `npm ci --omit=dev --no-audit --no-fund` (kompilasi `canvas`, beberapa menit)
2. `npm run verify:commands` (memuat seluruh registry command; kalau gagal,
   instalasi ikut gagal dan error-nya kelihatan di log install)

Kalau suatu saat ingin mengulang pengecekan tanpa akses shell, jalankan server
dengan startup command `node index.js --verify` — proses hanya memuat registry
lalu keluar dengan exit code 0/1, tanpa menyalakan sharder.

---

## 5. Database & Redis

Container bot **tidak bisa** menghubungi `127.0.0.1` milik host — itu loopback
container itu sendiri. Pakai IP jembatan Docker (biasanya `172.18.0.1`) atau IP
publik host, atau server DB terpisah.

### MariaDB

```bash
# di host
mysql -u root -p -e "CREATE DATABASE owo CHARACTER SET utf8mb4;"
mysql -u root -p owo < /path/ke/repo/secret/CREATE-OWO-TABLES.sql
mysql -u root -p -e "CREATE USER 'owo'@'172.18.%' IDENTIFIED BY 'PASSWORD_KUAT';
GRANT ALL PRIVILEGES ON owo.* TO 'owo'@'172.18.%'; FLUSH PRIVILEGES;"
```

Kalau memakai `.env`, semua info ini cukup dirangkum jadi
`DATABASE_URL=mysql://owo:PASSWORD_KUAT@172.18.0.1:3306/owo`.

`/etc/mysql/mariadb.conf.d/50-server.cnf`:

```ini
bind-address = 0.0.0.0
```

Pastikan port 3306 tidak terbuka ke internet (firewall hanya untuk `172.18.0.0/16`).

### Redis

```bash
# /etc/redis/redis.conf (atau /etc/redis.conf)
bind 0.0.0.0
protected-mode yes
requirepass PASSWORD_REDIS
```

Lalu isi di `.env`: `REDIS_URL=redis://:PASSWORD_REDIS@172.18.0.1:6379/0` (atau
`REDIS_PASS` kalau memakai variabel manual). Redis **wajib** karena prefix
per-server, cooldown, dan pub/sub lewat Redis.

---

## 6. `.env`

Buat `.env` di root server (File Manager). **Enam baris ini cukup**:

```ini
BOT_TOKEN=token_bot_dari_developer_portal
OWNER_IDS=123456789012345678

DATABASE_URL=mysql://owo:PASSWORD_KUAT@172.18.0.1:3306/owo
REDIS_URL=redis://:PASSWORD_REDIS@172.18.0.1:6379/0

PREFIX=o
CLUSTERS=2
```

Catatan:

- `DATABASE_URL` → `mysql://USER:PASSWORD@HOST:PORT/DATABASE` (skema
  `mariadb://` juga diterima). Password dengan karakter khusus harus di-encode:
  `@` → `%40`, `:` → `%3A`, `#` → `%23`.
- `REDIS_URL` → `redis://:PASSWORD@HOST:PORT/DB` (pakai `rediss://` kalau Redis
  pakai TLS). Tanpa password: `redis://172.18.0.1:6379`.
- **Tidak ada MongoDB** di project ini — databasenya MySQL/MariaDB.
- Cara lama (`MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASS`, `MYSQL_DATABASE`,
  `REDIS_HOST`, `REDIS_PASS`) masih jalan dan dipakai kalau URL tidak diisi.
  Kalau dua-duanya diisi, **URL yang menang**.
- Variabel panel (`CLUSTERS`, `PREFIX`, `OWNER_IDS`) menang atas `.env`, karena
  dotenv tidak menimpa env yang sudah ada.
- `ALLOW_EVAL=false` dan `DEBUG=false` sudah default; jangan dinyalakan di
  server publik. Opsi lain (cowoncy grant, sharder, integrasi) ada di
  `.env.example` — semuanya opsional.

Tanpa `BOT_TOKEN` proses langsung exit (exit code 1) — itu normal dan terlihat
di console.

## 7. Start & verifikasi

Klik **Start**, lalu cek console. Urutan log yang sehat:

```
config: ... (warning bila OWNER_IDS kosong)
[cluster:0] ... loading commands ...
bot ready: all shards connected        ← penanda siap (egg memakai ini)
```

Di Discord, uji:

```
o ping          → balasan latency
o help          → daftar command
o cash          → saldo cowoncy (butuh tabel ter-import)
o grant @user 1000   → hanya untuk owner / COWONCY_ADMIN_IDS
```

Kalau `bot ready` tidak muncul tapi proses hidup, jalankan self-check:

```
node index.js --doctor
```

(ubah sementara _Startup Command_ server menjadi `node index.js --doctor`, klik
Start, lalu kembalikan ke `node index.js`). Output-nya menunjukkan token valid
atau tidak, MESSAGE CONTENT INTENT nyala atau tidak, sumber jumlah shard, serta
apakah `DATABASE_URL`/`REDIS_URL` bisa dijangkau. Lihat bagian 9c kalau bot
terlihat offline atau command tidak dijawab.

---

## 8. Update bot

1. Upload ulang file yang berubah (atau upload zip baru dan extract menimpa).
2. **Reinstall Server** (menjalankan `npm ci` lagi).
3. Start.

Database tidak perlu di-import ulang — `CREATE-OWO-TABLES.sql` hanya untuk
instalasi pertama, dan tidak ada migrasi yang menghapus data.

---

## 9. Troubleshooting

| Gejala                                                    | Penyebab & solusi                                                                                                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Install gagal: `cairo.h: No such file` / `node-gyp` error | Image bukan hasil `pterodactyl/Dockerfile` (masih `yolks:nodejs_20`). Build image langkah 1 dan ganti nilai image di egg **dan** di install script.                                                                            |
| Start tapi crash `Cannot find module 'canvas'`            | `npm ci` dijalankan dengan image berbeda dari image runtime, atau Reinstall belum dijalankan setelah upload. Jalankan Reinstall, pastikan kedua image sama.                                                                    |
| `ECONNREFUSED 127.0.0.1:3306` / Redis                     | `MYSQL_HOST`/`REDIS_HOST` masih `localhost`. Pakai `172.18.0.1` atau IP host; cek `bind-address`/`bind` dan firewall.                                                                                                          |
| Server mati sendiri, log `heap out of memory`             | `CLUSTERS` terlalu besar untuk RAM. Turunkan ke 1–2 (atau naikkan limit memori server).                                                                                                                                        |
| Panel tetap "Starting" walau bot online                   | Log `bot ready: all shards connected` tidak terdeteksi; pastikan `LOG_LEVEL=info` (jangan `warn`/`error`), karena penanda itu level INFO.                                                                                      |
| Command memegen error `Could not grab drake.jpg`          | File `src/commands/commandList/memegen/img/*` tidak ikut ter-upload.                                                                                                                                                           |
| Install berhenti di `verify:commands`                     | Registry command gagal dimuat (file kurang / `node_modules` korup). Cek log install, upload ulang file yang kurang, lalu Reinstall lagi.                                                                                       |
| `mysql: DATABASE_URL is invalid` di log                   | Format URL salah (skema bukan `mysql://`/`mariadb://`, atau password belum di-encode). Bot otomatis jatuh ke `MYSQL_*`; perbaiki URL atau isi variabel manual.                                                                 |
| `node-pre-gyp ... 404 ... canvas-v2.11.2-node-v141`       | Node di image terlalu baru (mis. v25): canvas 2.11.2 tidak punya prebuilt untuk ABI itu. Sejak perbaikan ini `canvas` **opsional**, jadi install tetap sukses dan bot tetap jalan (memegen mati).                              |
| `pkg-config: not found` / `binding.gyp` gagal             | Image tidak punya cairo/pango/pkg-config untuk mengompilasi canvas. Bot tetap jalan tanpa memegen; pakai image `pterodactyl/Dockerfile` kalau butuh memegen.                                                                   |
| `git dep preparation failed`                              | Dulu disebabkan `merge-images` (git dep) yang punya devDependency `canvas`; dependensi itu sudah dihapus dari repo. Kalau masih muncul, periksa akses git/HTTPS node ke GitHub.                                                |
| `Cannot find module 'dotenv'` saat start                  | `npm install` belum selesai (exit 1), jadi `node_modules` tidak lengkap. Perbaiki penyebab install gagal, lalu Reinstall.                                                                                                      |
| `[CLUSTER] worker N exited …` berulang (crash loop)       | Cluster mati tepat setelah READY. Cek baris `[ERROR]` di atasnya; penyebab umum: `secret/macro.js`, `badwords.json`, atau `goodwords.json` hilang. Jalankan `node index.js --doctor` (sekarang memeriksa file wajib tersebut). |
| `[ERROR] [GATEWAY] no READY after 45s`                    | Identify tidak pernah selesai: token salah (4004), privileged intent belum ON (4014), atau `wss://gateway.discord.gg` diblokir. Buktikan dengan `node index.js --doctor --connect`.                                            |
| Command memegen jawab "needs the optional canvas module"  | Normal di host tanpa cairo/pango. Aktifkan dengan image custom (lihat bagian canvas opsional).                                                                                                                                 |
| Prefix tidak berubah                                      | Variabel panel `PREFIX` menang atas `.env`; ubah di tab Startup atau hapus variabelnya.                                                                                                                                        |
| `EACCES` saat menulis `secret/`                           | File ter-upload sebagai owner yang salah; lewat File Manager/SFTP panel (user `container`).                                                                                                                                    |

---

## 9c. Bot terlihat offline / command diabaikan

> **Penyebab utama "server RUNNING tapi bot OFFLINE" (sudah diperbaiki):**
> eris menginisialisasi presence dengan `status: "offline"` dan mengirim objek itu
> di dalam IDENTIFY (`lib/Client.js` + `lib/gateway/Shard.js`). Upstream OwO hanya
> mengubahnya lewat server sharder privatnya, jadi self-hoster berakhir dengan bot
> yang **connected + READY tetapi tampil OFFLINE**. Dua hal yang membuat
> perbaikannya tidak jalan sebelumnya:
>
> 1. eris-sharder memuat `src/owo.js` **di dalam** listener `ready` milik client
>    (`bot.once("ready", () => loadCode(bot))`), sehingga handler `ready` milik bot
>    dipasang setelah event itu lewat → presence tidak pernah dipasang. Sekarang
>    event itu di-replay sekali saat cluster dimuat (`src/utils/readyState.js` +
>    `EventHandler.replayReady()`).
> 2. Tidak ada instrumentation sebelum READY, jadi kegagalan identify tidak
>    terlihat. Sekarang `src/utils/gatewayBoot.js` menulis presence **sebelum** > `connect()` (IDENTIFY langsung "online") dan mencatat seluruh siklus gateway.
>
> Log yang akan terlihat di panel:
>
> ```
> [BOOT] OCEAN starting — node v20.x, pid 123, CLUSTERS=2
> [BOOT] running build 2cbdd6c728b1 (compare this with: node index.js --doctor)
> [SHARD] shards 0~0 of 1 (SHARDS env)
> [CONFIG] prefix=o debug=false clusters=2 shards=1 intents=130813
> [DISCORD] authentication successful — Ocean#5352 (id 1571…)
> [CLUSTER] worker 1 forked
> [CLUSTER] worker 1 online
> [GATEWAY] connecting with presence online — playing "o help" (attempt 1)
> [STATE] HELLO_RECEIVED — shard=0 heartbeat_interval=41250ms
> [GATEWAY] shard 0 socket open — sent IDENTIFY, waiting for READY
> [STATE] IDENTIFY_SENT — shard=0 intents=130813 presence=online shard=[0/1]
> [STATE] HEARTBEAT_ACKNOWLEDGED — shard=0
> [STATE] READY_RECEIVED — shard=0 Ocean guilds=1 session=abcdef12…
> [SHARD] shard 0 READY after 412ms
> [GATEWAY] all shards READY — 1 shard(s), 1 guild(s)
> [STATE] BOT_ONLINE — 1 shard(s), 1 guild(s)
> [STATE] PRESENCE_SYNCHRONIZED — status=online playing "o help"
> bot ready: Ocean#5352 in 1 guild(s), shard 0 - 0 — ONLINE (status online, playing "o help")
> Bot is online. Commands accept the prefix "o" (try "ohelp")
> [HEALTH] OCEAN IS ONLINE — Ocean#5352
> ```
>
> Kalau gateway gagal, yang muncul bukan diam:
>
> ```
> [ERROR] [GATEWAY] no READY after 45s — the identify never completed
> [ERROR] [GATEWAY] shard 0 disconnected: 4014 — disallowed intents — …
> [ACTION] stop the server and run: node index.js --doctor --connect …
> ```
>
> Dua penyebab tersering lainnya, keduanya juga dilaporkan di console:

**1. MESSAGE CONTENT INTENT belum nyala.** Bot connect dan tampak online, tapi
Discord mengirim `content` kosong, jadi `o help`, `o daily`, dan command lain
tidak pernah cocok. Sejak versi ini bot meminta intent itu **hanya kalau portal
mengizinkan** (kalau dipaksa saat portal mati, Discord menutup gateway dengan
4014 dan bot justru terlihat offline).

Perbaikan: Developer Portal → aplikasi kamu → **Bot** → _Privileged Gateway
Intents_ → **MESSAGE CONTENT INTENT** ON → Save → Restart server.

Console akan menunjukkan:

```
discord: application OCEAN (id 1571...); MESSAGE CONTENT INTENT DISABLED
discord: MESSAGE CONTENT INTENT is DISABLED for this application — ...
```

**2. Token salah / sudah di-reset.** Log-nya:

```
discord: BOT_TOKEN was rejected (HTTP 401) ...
```

atau saat shard gagal connect:

```
[shard 0] disconnected: 4004 — authentication failed — BOT_TOKEN is invalid ...
```

Salin token baru dari Developer Portal ke `BOT_TOKEN`.

**3. `DEBUG=true` tanpa `DEBUG_WHITELIST` yang benar.** Debug mode membuat bot
hanya menjawab guild yang ada di whitelist:

```
bot ready: Ocean#5352 in 1 guild(s), shard 0 - 0
bot ready: DEBUG mode is on — only DEBUG_WHITELIST guilds are answered
```

Isi `DEBUG_WHITELIST` dengan **ID guild** (Developer Mode → klik kanan server →
Copy Server ID), atau hapus `DEBUG` setelah sharding normal.

**4. Belum di-invite.** `bot ready: ... in 0 guild(s)` berarti bot tidak berada
di server mana pun; invite lewat
`https://discord.com/oauth2/authorize?client_id=<application id>&scope=bot&permissions=8`.

**5. Token tersalin lengkap dengan prefix `Bot `.** Nilai seperti
`Bot MTIz...` dulu menjadi `Bot Bot MTIz...` di gateway: REST tetap lolos
(`--doctor` bilang token valid) tetapi socket ditutup **4004** dan bot tidak
pernah online. Sekarang nilainya dinormalkan otomatis dan panel memberi tahu:

```
[CONFIG] BOT_TOKEN normalised — removed a duplicated "Bot " prefix; replace the panel variable with just the token
```

Tetap disarankan menyimpan variabelnya **tanpa** `Bot `, tanpa tanda kutip, tanpa
newline di belakang. Gejala khas kalau langkah ini terlewat: `--doctor` hijau,
`[GATEWAY] connecting …` muncul, lalu tidak ada `[STATE] IDENTIFY_SENT` /
`READY_RECEIVED`.

**6. Panel menjalankan source lama.** Pterodactyl menjalankan apa pun yang ada di
`/home/container`: upload zip, extract, dan Start adalah tiga langkah terpisah.
Bandingkan sidik jari build:

```
[BOOT] running build 2cbdd6c728b1     <- console server
[info] source build — 2cbdd6c728b1    <- node index.js --doctor
```

Kalau angkanya beda, panel masih memakai file lama: extract ulang arsipnya
(timpa semua file), lalu Start. Tanpa perbandingan ini tidak ada log yang bisa
membedakan "kode baru gagal" dari "kode lama masih jalan".

Kalau butuh semua jawaban sekaligus, jalankan `node index.js --doctor`.

## 9d. Sharding tanpa server sharder

`SHARDER_HOST` adalah service privat milik OwO upstream dan **tidak
dipublikasikan** — instalasi mandiri tidak perlu (dan tidak bisa) memakainya.
Urutan penentuan jumlah shard sekarang:

1. `SHARDS` / `SHARD_FIRST` / `SHARD_LAST` (kalau diisi),
2. `SHARDER_HOST` (kalau kamu benar-benar punya service-nya),
3. rekomendasi Discord dari `GET /gateway/bot`,
4. 1 shard kalau Discord tidak bisa dihubungi.

Log-nya menyebut sumbernya:

```
shard config: shards 0~0 of 1 (Discord's recommendation)
Creating shards 0~0 out of 1 total shards!
```

Command `o stats` dan `o shards` juga tetap jalan tanpa sharder server (dihitung
dari proses ini), dan `InfoUpdater`/`updateShardInfo` tidak lagi memanggil
endpoint yang tidak ada.

## 9a. Checklist "bot benar-benar ONLINE"

Jalankan berurutan. Setiap langkah punya bukti di console.

**1. Token valid.** Developer Portal → aplikasi kamu → **Bot** → _Reset Token_
kalau ragu, lalu salin ke `BOT_TOKEN` (jangan pakai tanda kutip).

**2. MESSAGE CONTENT INTENT ON.** Developer Portal → **Bot** → _Privileged
Gateway Intents_ → **MESSAGE CONTENT INTENT** → Save. Tanpa ini bot online tapi
tidak pernah menjawab command.

**3. Bot di-invite.** Kalau belum:
`https://discord.com/oauth2/authorize?client_id=<application id>&scope=bot&permissions=8`
(tukar `<application id>` dengan _Application ID_, bukan token).

**4. Startup Command = `node index.js`.** Jangan `npm start` berkali-kali di
Startup Command — Pterodactyl menjalankan satu perintah saja.

**5. Start server**, lalu cari log ini:

```
discord: token ok — Ocean#5352 (id …)
discord: application OCEAN (id …); MESSAGE CONTENT INTENT enabled
shard config: shards 0~0 of 1 (Discord's recommendation)
Creating shards 0~0 out of 1 total shards!
[Cluster 0] Connecting with 1 shard(s)
bot ready: Ocean#5352 in 1 guild(s), shard 0 - 0 — ONLINE (status online, playing "o help")
Bot is online. Commands accept the prefix "o" (try "ohelp")
```

Baris `bot ready` adalah penanda yang dipakai egg (`config.startup.done`), jadi
setelah baris itu panel menandai server **running** dan bot tampil online.

**6. Uji di Discord:** `ohelp`, lalu `oping`. Kalau `ohelp` diam padahal baris
`bot ready` muncul: intent belum ON, atau `DEBUG=true` tanpa `DEBUG_WHITELIST`
yang benar, atau bot tidak punya izin _Read Messages/Send Messages_ di channel
itu.

**7. Verifikasi login gateway (opsional, paling meyakinkan):**

```
node index.js --doctor --connect
```

Perintah ini benar-benar login ke gateway, mencetak
`[ok] gateway login — connected as Ocean#5352 … the bot can appear online`, lalu
disconnect. **Hentikan server dulu** — dua koneksi dengan token yang sama akan
saling menendang (duplicate login).

---

## 9e. Presence (status) dan aktivitas

Bot sekarang memasang presence sendiri setiap kali `ready`, jadi tidak lagi
bergantung pada server sharder upstream. Semua lewat environment:

```ini
BOT_STATUS=online          # online | idle | dnd | invisible
BOT_ACTIVITY_TYPE=playing  # playing | watching | listening | competing | streaming | custom
BOT_ACTIVITY_TEXT=o help   # placeholder: {guilds} {users} {shards} {prefix}
BOT_ACTIVITY_URL=          # wajib kalau type=streaming
BOT_PRESENCE_REFRESH_SEC=0 # >0 = perbarui berkala (mis. 600)
```

Contoh:

| Konfigurasi                                           | Tampilan di Discord      |
| ----------------------------------------------------- | ------------------------ |
| `BOT_ACTIVITY_TYPE=playing`, text `o help`            | **Playing** o help       |
| `BOT_ACTIVITY_TYPE=watching`, text `{guilds} servers` | **Watching** 1 servers   |
| `BOT_ACTIVITY_TYPE=listening`, text `o help`          | **Listening to** o help  |
| `BOT_ACTIVITY_TYPE=custom`, text `o help`             | **Custom Status** o help |
| `BOT_ACTIVITY_TYPE=streaming` + `BOT_ACTIVITY_URL`    | **Live on Twitch** …     |

Catatan:

- `BOT_STATUS=invisible` membuat bot **terlihat offline** meskipun prosesnya
  jalan. Jangan dipakai saat mengejar "harus online".
- `streaming` tanpa `BOT_ACTIVITY_URL` otomatis turun ke `playing` (Discord
  menolak streaming tanpa URL).
- Presence dipasang ulang otomatis setelah shard `resume`, jadi tidak hilang
  setelah gateway reconnect.

---

## 9f. 24/7 di Pterodactyl

1. **Crash cluster ditangani sendiri.** eris-sharder memfork ulang worker yang
   mati (`Cluster Manager | cluster 0 died … Restarting`); proses master tetap
   hidup sehingga bot kembali online tanpa campur tangan panel.
2. **Proses master mati = server offline di panel.** Pterodactyl tidak punya
   auto-restart untuk proses yang exit. Solusi:
   - Start server setelah node/daemon restart — Wings otomatis menyalakan server
     yang sebelumnya dalam status _running_ saat node dimatikan normal.
   - Buat **Schedule** di panel (Schedule → New Task, mis. tiap 6 jam) dengan
     aksi **Restart Server** sebagai jaring pengaman. Jangan lebih sering dari
     1×/jam: setiap restart memakai jatah _identify_ gateway (1000/hari).
   - Panel **tidak** butuh Discord/Termux: selama server panel hidup, bot
     berjalan sendiri.
3. **Duplicate login.** Satu token hanya boleh jalan di satu tempat. Kalau bot
   tiba-tiba offline bersamaan dengan munculnya instance lain (panel lain,
   Termux, laptop), matikan yang lain — kalau tidak, keduanya saling tendang dan
   terlihat seperti "reconnect loop".
4. **Reconnect loop.** Kalau log berulang `disconnected: 4004` atau `4014`,
   itu bukan loop jaringan tetapi token/intent yang salah — perbaiki dulu.

---

## 9g. Optimasi RAM/CPU di panel kecil (2 GB)

| Setelan                    | Rekomendasi                | Alasan                                                              |
| -------------------------- | -------------------------- | ------------------------------------------------------------------- |
| `CLUSTERS`                 | `1`–`2`                    | tiap cluster proses Node penuh (~120–200 MB). Default repo 60 = OOM |
| `DD_TRACE_ENABLED`         | `false`                    | agent tracing dd-trace memakan puluhan MB tanpa manfaat di panel    |
| `SHARDS`                   | kosong                     | biar Discord menentukan; jangan paksa lebih besar dari perlu        |
| `BOT_PRESENCE_REFRESH_SEC` | `0`                        | refresh presence terlalu sering = request gateway tambahan          |
| `NODE_OPTIONS` (opsional)  | `--max-old-space-size=384` | membatasi heap V8 supaya GC jalan lebih awal                        |
| `LOG_LEVEL`                | `info`                     | `debug` menghasilkan ribuan baris dan memperlambat panel            |

Cek pemakaian dari console panel: `Memory` normalnya 120–250 MB untuk 1–2
cluster. Kalau mendekati batas, turunkan `CLUSTERS` dulu sebelum menaikkan RAM.

---

## 9b. canvas opsional — bot jalan tanpa memegen

`canvas` sekarang ada di **`optionalDependencies`**. Artinya kalau host tidak
bisa mengompilasinya (image bawaan Pterodactyl, Node 25, tanpa
`pkg-config`/cairo), **`npm install`/`npm ci` tetap sukses** dan bot tetap
start — dulu install gagal total dan berakhir dengan `Cannot find module
'dotenv'`.

Yang berubah saat canvas tidak tersedia: 11 command memegen (`communism`,
`distracted`, `drake`, `eject`, `emergency`, `headpat`, `isthisa`, `slapcar`,
`spongebobchicken`, `tradeoffer`, `waddle`) menjawab _"needs the optional
`canvas` module"_. Command lain (hunt, battle, ekonomi, gambling, sosial,
ranking, dst.) normal.

Untuk menghidupkan memegen: build image `pterodactyl/Dockerfile` (Alpine +
cairo/pango/pixman/dev headers) dan jalankan dengan **Node 20**, karena canvas
2.11.2 tidak menyediakan prebuilt untuk Node yang lebih baru.

## 10. Catatan keamanan

- **Jangan** set `ALLOW_EVAL=true` di panel publik; default `false` sudah aman.
- `OWNER_IDS` kosong = tidak ada owner, bukan "semua boleh".
- `grant` (menambah cowoncy) hanya untuk owner / `COWONCY_ADMIN_IDS` /
  `COWONCY_ADMIN_ROLE_IDS` — lihat [SECURITY.md](SECURITY.md).
- Simpan `.env` hanya di volume server; jangan commit ke git.
- Kalau bot di-hosting untuk publik, pantau pemakaian RAM: setiap `CLUSTERS`
  adalah satu proses Node penuh.

---

## Alternatif tanpa Pterodactyl

`docker-compose.yml` di repo ini sudah menyiapkan bot + MariaDB + Redis dalam
satu stack (`docker compose up -d --build`) — lihat [DEPLOYMENT.md](DEPLOYMENT.md).
