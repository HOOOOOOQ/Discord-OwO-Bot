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

| Gejala                                                    | Penyebab & solusi                                                                                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install gagal: `cairo.h: No such file` / `node-gyp` error | Image bukan hasil `pterodactyl/Dockerfile` (masih `yolks:nodejs_20`). Build image langkah 1 dan ganti nilai image di egg **dan** di install script.                                               |
| Start tapi crash `Cannot find module 'canvas'`            | `npm ci` dijalankan dengan image berbeda dari image runtime, atau Reinstall belum dijalankan setelah upload. Jalankan Reinstall, pastikan kedua image sama.                                       |
| `ECONNREFUSED 127.0.0.1:3306` / Redis                     | `MYSQL_HOST`/`REDIS_HOST` masih `localhost`. Pakai `172.18.0.1` atau IP host; cek `bind-address`/`bind` dan firewall.                                                                             |
| Server mati sendiri, log `heap out of memory`             | `CLUSTERS` terlalu besar untuk RAM. Turunkan ke 1–2 (atau naikkan limit memori server).                                                                                                           |
| Panel tetap "Starting" walau bot online                   | Log `bot ready: all shards connected` tidak terdeteksi; pastikan `LOG_LEVEL=info` (jangan `warn`/`error`), karena penanda itu level INFO.                                                         |
| Command memegen error `Could not grab drake.jpg`          | File `src/commands/commandList/memegen/img/*` tidak ikut ter-upload.                                                                                                                              |
| Install berhenti di `verify:commands`                     | Registry command gagal dimuat (file kurang / `node_modules` korup). Cek log install, upload ulang file yang kurang, lalu Reinstall lagi.                                                          |
| `mysql: DATABASE_URL is invalid` di log                   | Format URL salah (skema bukan `mysql://`/`mariadb://`, atau password belum di-encode). Bot otomatis jatuh ke `MYSQL_*`; perbaiki URL atau isi variabel manual.                                    |
| `node-pre-gyp ... 404 ... canvas-v2.11.2-node-v141`       | Node di image terlalu baru (mis. v25): canvas 2.11.2 tidak punya prebuilt untuk ABI itu. Sejak perbaikan ini `canvas` **opsional**, jadi install tetap sukses dan bot tetap jalan (memegen mati). |
| `pkg-config: not found` / `binding.gyp` gagal             | Image tidak punya cairo/pango/pkg-config untuk mengompilasi canvas. Bot tetap jalan tanpa memegen; pakai image `pterodactyl/Dockerfile` kalau butuh memegen.                                      |
| `git dep preparation failed`                              | Dulu disebabkan `merge-images` (git dep) yang punya devDependency `canvas`; dependensi itu sudah dihapus dari repo. Kalau masih muncul, periksa akses git/HTTPS node ke GitHub.                   |
| `Cannot find module 'dotenv'` saat start                  | `npm install` belum selesai (exit 1), jadi `node_modules` tidak lengkap. Perbaiki penyebab install gagal, lalu Reinstall.                                                                         |
| Command memegen jawab "needs the optional canvas module"  | Normal di host tanpa cairo/pango. Aktifkan dengan image custom (lihat bagian canvas opsional).                                                                                                    |
| Prefix tidak berubah                                      | Variabel panel `PREFIX` menang atas `.env`; ubah di tab Startup atau hapus variabelnya.                                                                                                           |
| `EACCES` saat menulis `secret/`                           | File ter-upload sebagai owner yang salah; lewat File Manager/SFTP panel (user `container`).                                                                                                       |

---

## 9c. Bot terlihat offline / command diabaikan

Dua penyebab tersering, keduanya sekarang dilaporkan di console:

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
