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

Setelah file ter-upload: tekan **Reinstall Server** (egg akan menjalankan
`npm ci --omit=dev`; kompilasi `canvas` butuh beberapa menit).

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

Lalu isi `REDIS_PASS` di `.env`. Redis **wajib** karena prefix per-server,
cooldown, dan pub/sub lewat Redis.

---

## 6. `.env`

Buat `.env` di root server (File Manager) — jangan lewatkan langkah ini:

```ini
BOT_TOKEN=token_bot_dari_developer_portal
OWNER_IDS=123456789012345678
PREFIX=o
CLUSTERS=2

MYSQL_HOST=172.18.0.1
MYSQL_USER=owo
MYSQL_PASS=PASSWORD_KUAT
MYSQL_DATABASE=owo
REDIS_HOST=172.18.0.1
REDIS_PASS=PASSWORD_REDIS

DEBUG=false
ALLOW_EVAL=false
EXIT_ON_FATAL=true
LOG_LEVEL=info

# opsional: siapa saja yang boleh menambah cowoncy
# COWONCY_ADMIN_IDS=111111111111111111,222222222222222222
# COWONCY_ADMIN_ROLE_IDS=333333333333333333
# COWONCY_GRANT_MAX=1000000000
```

Semua kunci yang tersedia ada di `.env.example`. Tanpa `BOT_TOKEN` proses
langsung exit (exit code 1) — itu normal dan terlihat di console.

---

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

Kalau `bot ready` tidak muncul tapi proses hidup: token salah, atau bot belum
di-invite ke guild mana pun.

---

## 8. Update bot

1. Upload ulang file yang berubah (atau upload zip baru dan extract menimpa).
2. **Reinstall Server** (menjalankan `npm ci` lagi).
3. Start.

Database tidak perlu di-import ulang — `CREATE-OWO-TABLES.sql` hanya untuk
instalasi pertama, dan tidak ada migrasi yang menghapus data.

---

## 9. Troubleshooting

| Gejala                                                    | Penyebab & solusi                                                                                                                                           |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install gagal: `cairo.h: No such file` / `node-gyp` error | Image bukan hasil `pterodactyl/Dockerfile` (masih `yolks:nodejs_20`). Build image langkah 1 dan ganti nilai image di egg **dan** di install script.         |
| Start tapi crash `Cannot find module 'canvas'`            | `npm ci` dijalankan dengan image berbeda dari image runtime, atau Reinstall belum dijalankan setelah upload. Jalankan Reinstall, pastikan kedua image sama. |
| `ECONNREFUSED 127.0.0.1:3306` / Redis                     | `MYSQL_HOST`/`REDIS_HOST` masih `localhost`. Pakai `172.18.0.1` atau IP host; cek `bind-address`/`bind` dan firewall.                                       |
| Server mati sendiri, log `heap out of memory`             | `CLUSTERS` terlalu besar untuk RAM. Turunkan ke 1–2 (atau naikkan limit memori server).                                                                     |
| Panel tetap "Starting" walau bot online                   | Log `bot ready: all shards connected` tidak terdeteksi; pastikan `LOG_LEVEL=info` (jangan `warn`/`error`), karena penanda itu level INFO.                   |
| Command memegen error `Could not grab drake.jpg`          | File `src/commands/commandList/memegen/img/*` tidak ikut ter-upload.                                                                                        |
| Prefix tidak berubah                                      | Variabel panel `PREFIX` menang atas `.env`; ubah di tab Startup atau hapus variabelnya.                                                                     |
| `EACCES` saat menulis `secret/`                           | File ter-upload sebagai owner yang salah; lewat File Manager/SFTP panel (user `container`).                                                                 |

---

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
