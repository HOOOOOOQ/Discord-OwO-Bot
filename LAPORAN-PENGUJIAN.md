# LAPORAN PENGUJIAN — OCEAN BOT (putaran 4–5: startup & koneksi gateway)

Diperbarui: putaran 5, branch `arena/cc786545-discord-owo-bot` (lanjutan `master` `497ec95`).
Semua angka di bawah berasal dari perintah yang **benar-benar dijalankan di repo ini**.
Yang tidak bisa dijalankan di sandbox ditandai **BELUM TERVERIFIKASI** beserta alasannya.

## 0. Ringkasan: kenapa bot tidak pernah online

Ada **tiga** penyebab, semuanya dibuktikan dengan menjalankan `node index.js` sungguhan
(master + worker eris-sharder) di sandbox, bukan dengan membaca kode saja.

### Penyebab 1 — worker yang di-restart tidak pernah menerima tugas shard-nya

`eris-sharder@1.10.0`, `src/utils/queue.js`:

```js
queueItem(item) {
  if (this.queue.length === 0) { this.queue.push(item); this.executeQueue(); }
  else this.queue.push(item);          // <-- hanya ditumpuk, tidak pernah dikirim
}
executeQueue() { const item = this.queue[0]; this.emit("execute", item); }
```

Tidak ada kode yang pernah menghapus `queue[0]`. Jadi **setelah tugas pertama**, antrean
selalu tidak kosong dan setiap `queueItem` berikutnya — yaitu **setiap kali sebuah cluster
di-restart** (crash, OOM, restart dari panel) — hanya ditumpuk dan tidak pernah dikirim.
Worker baru tidak menerima pesan `connect`, sehingga:

- tidak ada objek Eris / client Discord sama sekali di worker itu,
- tidak ada percobaan WebSocket, tidak ada error, tidak ada log,
- panel menampilkan **"worker online"** padahal bot tidak pernah terhubung.

Bukti dari percobaan nyata (sebelum perbaikan), dengan probe pada `cluster.fork` dan `Queue`:

```
[PROBE] fork → worker 1
[PROBE] queueItem cluster=0 lenBefore=0
[PROBE] emit execute cluster=0
[PROBE] master sends "connect" to worker 1 (cluster 0)
[PROBE] queueItem done lenAfter=1
--- worker 1 mati (token/DB/gateway gagal) → eris-sharder restart ---
[PROBE] fork → worker 2
[PROBE] queueItem cluster=0 lenBefore=1     <-- tidak pernah dieksekusi
[PROBE] queueItem done lenAfter=2
[PROBE] fork → worker 3
[PROBE] queueItem cluster=0 lenBefore=2
[PROBE] queueItem done lenAfter=3           <-- tumbuh terus, tidak pernah dikirim
```

Worker 2 dan seterusnya tidak pernah mengirim `ipc_connect_received`.

**Perbaikan.** `src/utils/shardAssignment.js` → `installQueueFix(sharder)` mengganti
`queueItem` pada instance (tanpa mengubah `node_modules`): kirim langsung, catat apakah
pengiriman berhasil, dan **selalu kosongkan antrean** sehingga tidak menumpuk. Master juga
mencatat ack **per worker** (bukan per nomor cluster) dan mengirim ulang tugas untuk worker
baru bila pustaka gagal.

Bukti setelah perbaikan:

```
[CLUSTER] repaired eris-sharder's assignment queue — a restarted cluster gets its shard assignment again
[CLUSTER] worker 1 forked
[cluster:boot] [GATEWAY] stage ipc_connect_received — cluster 0, shards 0~0 of 1
[cluster:boot] [GATEWAY] connecting with presence online — watching "discord.gg/666family" (attempt 1)
[CLUSTER] worker 2 forked (respawn #1)
[CLUSTER] cluster 0 is served by worker 2 now (was 1) — its shard assignment was delivered again
[cluster:boot] [GATEWAY] stage ipc_connect_received — cluster 0, shards 0~0 of 1
...
→ 4 worker berbeda menerima tugas shard (sebelumnya: 1)
```

### Penyebab 2 — master tidak pernah berhenti saat semua worker mati

eris-sharder me-re-fork worker tanpa batas. Kalau penyebabnya permanen (token salah,
`MESSAGE CONTENT` intent salah, IP host diblokir, MongoDB mati), proses master tetap hidup
selamanya: panel melihat "running", tidak ada status error, bot tidak pernah online.

**Perbaikan.** `index.js` menghitung kematian worker dalam 60 detik; pada kematian ke-4
master menulis `[FATAL] stopping the master to end the restart loop` lalu `exit(1)`
(bisa dimatikan dengan `EXIT_ON_CRASH_LOOP=false`). Panel kini menampilkan crash, bukan
server "sehat" yang bohong.

### Penyebab 3 (ditemukan dari log panel Anda, build `4ab00e5c9a45`) — tugas shard dikirim sebelum worker siap mendengarkan

Log Anda:

```
06:57:13.144  [CLUSTER] worker 1 forked
06:57:14.285  [cluster:boot] [DATABASE] connecting to MongoDB...
06:57:19.949  [MONGO] connected — mongodb+srv://***@lagukan…
06:57:19.952  [GATEWAY] stage sharder_constructed — path /src/owo.js
06:57:29.28   ERROR [DIAG] stages: process_started=1ms | sharder_constructed=5674ms |
              ipc_connect_received=NOT REACHED | connect_called=NOT REACHED | …
```

Master mengirim pesan IPC `connect` **tepat setelah fork** (≈06:57:13.14), tetapi
eris-sharder baru mendaftarkan listener IPC-nya saat `new Sharder(...)` dibuat —
yaitu **setelah** pre-flight MongoDB di worker selesai (di host Anda 5,7 detik).
Pesan yang tiba sebelum ada listener **hilang**: worker hidup, tidak punya objek Eris
sama sekali, dan tidak ada error.

Diperparah oleh aturan master sebelumnya: fallback hanya mengirim ulang kalau
`worker.send()` melempar error. `send()` "berhasil" (pesan hanya masuk ke channel),
jadi master menganggap tugas sudah sampai padahal tidak.

**Perbaikan.**

1. Worker menangkap pesan `connect` di baris-baris pertama `index.js` (sebelum
   MongoDB/sharder dimuat) dan menyimpannya. Setelah `new Sharder(...)` selesai,
   pesan itu di-_replay_ (`process.emit('message', …)`) sehingga client Eris benar-benar
   dibuat. Hanya satu salinan yang di-replay → tidak mungkin dua client.
2. Master sekarang memakai **ack worker** (`ipc_connect_received`) sebagai satu-satunya
   bukti: kalau worker belum ack, tugas dikirim ulang pada +4 s, +9 s, +16 s dan lewat
   sweep tiap 5 detik (selama 2 menit).
3. Watchdog startup tidak lagi menghitung total waktu boot: **setiap stage memulai ulang
   hitungan**, jadi worker yang butuh 6 detik memuat modul tidak lagi dilaporkan sebagai
   "CONNECTION NOT STARTED".

Bukti (reproduksi di sandbox dengan Mongo 6 detik, sebelum vs sesudah):

```
# sebelum
[DATABASE] connecting to MongoDB...            (6 s)
[GATEWAY] stage sharder_constructed
ERROR [GATEWAY] CONNECTION NOT STARTED         connect_called=NOT REACHED

# sesudah
[GATEWAY] stage ipc_connect_received — cluster 0
[GATEWAY] stage ipc_connect_buffered — cluster 0 arrived before eris-sharder was listening
[GATEWAY] stage sharder_constructed
WARN [CLUSTER] the shard assignment (cluster 0, shards 0~0) arrived before eris-sharder was
     listening — replaying it now so the client is created
[GATEWAY] stage connect_called — Client at 6010ms
```

Juga: `dd-trace` sekarang **mati secara default** (di log Anda ia mencoba menghubungi
agen Datadog di `127.0.0.1:8126` dan gagal setiap boot).

## 1. `node src/owo.js` — kenapa bot tetap gagal terhubung

`src/owo.js` **bukan** entry point: itu kelas worker (`class OwO extends Base`) yang hanya
dipanggil eris-sharder _setelah_ gateway READY. Menjalankannya langsung dulu berakhir
dengan `exit 0` dan **tanpa output apa pun**, sehingga terlihat seperti "bot gagal
terhubung".

Sekarang ada penjaga di awal file:

```
$ node src/owo.js
src/owo.js TIDAK bisa dijalankan langsung / cannot be started directly.
...
    node index.js
```

`exit code 1`, pesan menyebutkan entry point yang benar dan `node index.js --doctor`.

## 2. Hasil pemeriksaan (semua dijalankan pada putaran ini)

| #   | Pemeriksaan                             | Perintah                                                      | Hasil                                                                                                                                                  |
| --- | --------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Syntax seluruh JS                       | `for f in $(git ls-files '*.js'); do node --check "$f"; done` | **PASS** — 0 gagal                                                                                                                                     |
| 2   | Dependency                              | `npm ci` + `npm ls --depth=0`                                 | **PASS** — 23 paket produksi, tanpa MySQL/Redis                                                                                                        |
| 3   | Unit + regresi                          | `MONGO_OFFLINE=true npm test`                                 | **PASS** — **275 pass / 0 fail** (36 file)                                                                                                             |
| 4   | ESLint / Prettier                       | `npm run lint`, `npx prettier --check .`                      | **PASS** — 0 error, format bersih                                                                                                                      |
| 5   | Registry command                        | `npm run verify:commands`                                     | **PASS** — 285 command, 526 alias, 50 admin, 11 grup (tidak berkurang)                                                                                 |
| 6   | Startup `node src/owo.js`               | `node --test test/startup.test.js`                            | **PASS** — exit 1 + arahan `node index.js`                                                                                                             |
| 7   | Startup `node index.js` (token ditolak) | `node --test test/startup.test.js`                            | **PASS** — urutan log benar, worker baru dapat tugas shard, master exit 1                                                                              |
| 7b  | Worker lambat (Mongo +4 detik)          | `node --test test/startup.test.js`                            | **PASS** — tugas dibuffer lalu di-replay; `connect_called` tercapai (sebelumnya `NOT REACHED`)                                                         |
| 8   | Mongo siap sebelum command              | `node --test test/mongoReady.test.js`                         | **PASS** — `whenReady` retry, `MONGODB_NOT_READY` menyertakan sebab asli                                                                               |
| 9   | Prefix `o`                              | `test/pipeline.test.js`                                       | **PASS** — `ohelp`, `o help`, `OHELP`, `O HELP`, `o ping`, `oprofile`, `o profile`, `o stats`, `o invite`, `o prefix`, prefix custom `!`, typo dijawab |
| 10  | Diagnostik                              | `node index.js --doctor`                                      | 28 pemeriksaan, **2 gagal** (gateway websocket & database) — keduanya karena sandbox tanpa jaringan/kredensial, lihat §5                               |
| 11  | MongoDB mati saat boot                  | `node index.js` + URI tak terjangkau                          | **PASS** — pesan jelas, `exit 1`, tanpa fork worker                                                                                                    |
| 12  | Tidak ada restart tanpa akhir           | skenario #7                                                   | **PASS** — `crash loop` → `[FATAL]` → `exit 1`                                                                                                         |

## 3. File yang diubah

| File                                  | Perubahan                                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/utils/shardAssignment.js`        | `installQueueFix()` (memperbaiki antrean eris-sharder), `libraryDelivered()`, `libraryDeliveryError()`, dukungan `acknowledgedFor` (ack per worker)                                                    |
| `index.js`                            | pasang perbaikan antrean, kirim ulang tugas per-fork + sweep, ack per worker, `[FATAL]` + exit pada crash loop, log `[ENV]` / `[DATABASE]` / `[DISCORD]`, token dinormalkan sebelum `GET /gateway/bot` |
| `src/owo.js`                          | penjaga entry point, `mongoReady` menunggu koneksi + `setOptOut`, log `[DATABASE] connected` dan `[DISCORD] successfully connected`                                                                    |
| `src/eventHandlers/messageCreate.js`  | menunggu `mongoReady` sebelum memproses command (menghilangkan `MONGODB_NOT_READY` bagi user)                                                                                                          |
| `src/eventHandlers/ready.js`          | log `[DISCORD] successfully connected` dan `[BOT] Ready`                                                                                                                                               |
| `src/utils/mongo/client.js`           | `whenReady()` mencoba ulang koneksi; pesan `MONGODB_NOT_READY` menyertakan error terakhir                                                                                                              |
| `src/utils/gatewayBoot.js`            | log percobaan terakhir tidak lagi berbunyi "retrying"                                                                                                                                                  |
| `.env.example`                        | `EXIT_ON_CRASH_LOOP`, hapus variabel yang tidak dipakai kode (`IMAGE_GEN_*`, `SITE_API`, `SITE_PASS`, `GEN_ASSET_HOST`)                                                                                |
| `test/startup.test.js` (baru)         | spawn `node src/owo.js` dan `node index.js` sungguhan                                                                                                                                                  |
| `test/mongoReady.test.js` (baru)      | retry `whenReady` dan pesan `MONGODB_NOT_READY`                                                                                                                                                        |
| `test/fixtures/memoryMongo.js` (baru) | MongoDB in-memory untuk tes startup                                                                                                                                                                    |
| `test/shardAssignment.test.js`        | +4 tes: antrean diperbaiki, kegagalan kirim tercatat, tidak ada kiriman ganda, ack per worker                                                                                                          |
| `test/pipeline.test.js`               | +1 tes: `oprofile` dan `o profile`                                                                                                                                                                     |

## 4. Env yang benar-benar dipakai

Wajib:

```
BOT_TOKEN=            # token saja, tanpa "Bot " dan tanpa tanda kutip
MONGODB_URI=mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/ocean
```

Disarankan (default sudah aman):

```
PREFIX=o
CLUSTERS=1
DEBUG=false
BOT_STATUS=online
BOT_ACTIVITY_TYPE=watching
BOT_ACTIVITY_TEXT=discord.gg/666family
```

Tambahan opsional yang relevan dengan startup: `GATEWAY_CONNECT_ATTEMPTS` (default 6),
`EXIT_ON_CRASH_LOOP` (default true), `MONGODB_CONNECT_ATTEMPTS` (default 5),
`ERIS_MESSAGE_CONTENT` (default auto), `SHARDS`/`SHARD_FIRST`/`SHARD_LAST`.

`DATABASE_URL`, `REDIS_URL`, `MYSQL_*`, `REDIS_*` **tidak dipakai** — bot hanya memakai
MongoDB. Token/password tidak pernah dicetak (URI dimasking menjadi `mongodb://***@host/db`).

## 5. Yang BELUM TERVERIFIKASI (butuh akses Anda)

| Hal                                      | Kenapa                                                         | Cara memastikan di host                                                                                        |
| ---------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| READY asli + status **Online**           | sandbox tidak punya rute ke `discord.com`/`gateway.discord.gg` | start bot, tunggu `[DISCORD] successfully connected`, `[BOT] Ready`, `[HEALTH] OCEAN IS ONLINE`                |
| Activity `Watching discord.gg/666family` | sama                                                           | lihat profil bot di Discord                                                                                    |
| Reconnect jaringan nyata (4000/1006)     | butuh sesi gateway asli                                        | putuskan jaringan host sebentar; harus muncul `[GATEWAY] connecting …` lalu `[DISCORD] successfully connected` |
| Baca/tulis Atlas asli                    | butuh `MONGODB_URI` Anda                                       | bot **stop**, lalu `MONGODB_URI='mongodb+srv://…' npm run verify:db`                                           |

## 6. Startup command final (Pterodactyl)

```
node index.js
```

Jangan memakai `node src/owo.js`. Diagnostik aman dijalankan kapan saja: `node index.js --doctor`.

Urutan log yang sehat:

```
[BOOT] OCEAN starting — node v22 … CLUSTERS=1
[ENV] configuration loaded — prefix=o debug=false clusters=1 shards=1 intents=130813
[DATABASE] connecting to MongoDB...
[DATABASE] connected — the bot can read and write its data
[DISCORD] connecting to the gateway — shards 0~0 of 1, 1 cluster(s)
[CLUSTER] repaired eris-sharder's assignment queue …
[GATEWAY] connecting with presence online — watching "discord.gg/666family" (attempt 1)
[DISCORD] successfully connected — gateway READY, N guild(s)
[BOT] Ready — prefix "o" (try "ohelp")
[HEALTH] OCEAN IS ONLINE
```

Kalau gagal, penyebab aslinya ikut tercetak (bukan hanya "worker online"):

```
[GATEWAY] getBotGateway() failed: 401 Unauthorized        → token salah
[GATEWAY] connect attempt 1/6 failed — retrying in 5s …   → percobaan berikutnya
[FATAL] the gateway never opened after 6 attempt(s)       → worker berhenti, master restart
[ERROR] crash loop: 4 worker exits in 60s                 → [FATAL] master berhenti (exit 1)
```
