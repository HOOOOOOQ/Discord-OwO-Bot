# OCEAN Bot — Panduan Bahasa Indonesia (MongoDB saja)

Bot Discord OCEAN (fork dari OwO Bot). **Yang dibutuhkan hanya dua hal:**

1. Discord Bot Token
2. MongoDB Atlas Connection String

Tidak ada MySQL, MariaDB, Redis, atau server database lain. Semua data (user,
cowoncy, hewan, battle, giveaway, XP, prefix per server, cooldown, quest,
patreon, beehive, autohunt) disimpan di MongoDB Atlas.

Prefix default: **`o`** — `ohelp` dan `o help` dua-duanya bisa.

---

## 1. Yang perlu disiapkan

| Kebutuhan | Keterangan |
| --- | --- |
| Akun Discord + bot | https://discord.com/developers/applications |
| MongoDB Atlas (gratis M0) | https://cloud.mongodb.com |
| Pterodactyl panel | versi apa saja, egg Node.js 20/22 |
| Node.js | **20 atau 22** (repo diuji di Node 22) |

RAM: 1 cluster ≈ 200–350 MB. Untuk panel 1–2 GB pakai `CLUSTERS=1`.

---

## 2. Membuat database di MongoDB Atlas

1. Daftar/masuk ke https://cloud.mongodb.com → **Create** → pilih **M0 Free** →
   region terdekat (mis. Singapore) → Create.
2. **Database Access** → **Add New Database User**
   - Username: `ocean`
   - Password: klik *Autogenerate* dan **simpan** passwordnya
   - Role: *Read and write to any database*
3. **Network Access** → **Add IP Address** → **Allow Access from Anywhere**
   (`0.0.0.0/0`). Wajib: IP host Pterodactyl berubah-ubah.
4. **Clusters** → **Connect** → **Drivers** → **Node.js** → salin connection
   string, bentuknya:

   ```
   mongodb+srv://ocean:<password>@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority
   ```

5. Tambahkan nama database sebelum `?`, jadi:

   ```
   mongodb+srv://ocean:PASSWORD@cluster0.abcde.mongodb.net/ocean?retryWrites=true&w=majority
   ```

   Bagian `/ocean` itu nama database. Kalau password mengandung `@ : / ;`
   ganti dengan `%40 %3A %2F %3B`.

Tabel dan index dibuat **otomatis** saat bot pertama kali jalan — tidak perlu
import file SQL apa pun.

---

## 3. Membuat bot di Discord Developer Portal

1. https://discord.com/developers/applications → **New Application** → beri nama.
2. **Bot** → **Reset Token** → salin token (jangan pakai awalan `Bot `).
3. **Bot** → **Privileged Gateway Intents** → nyalakan:

   | Intent | Wajib? | Kenapa |
   | --- | --- | --- |
   | **Message Content Intent** | **WAJIB** | tanpa ini bot online tapi semua command diabaikan |
   | Server Members | opsional | untuk fitur level/role member |
   | Presence | tidak perlu | bot tidak membaca presence user |

4. **OAuth2 → URL Generator** → scope `bot` + `applications.commands`,
   permissions `Administrator` (atau minimal Send Messages, Embed Links,
   Read Message History, Add Reactions, Manage Messages) → invite ke server.

Tanpa **Message Content Intent**, `ohelp` tidak akan dijawab sama sekali. Ini
penyebab paling umum "bot online tapi tidak merespons".

---

## 4. Menjalankan di Pterodactyl

1. Upload seluruh isi ZIP ke folder server (`/home/container`), termasuk
   `package.json`, `package-lock.json`, `index.js`, `src/`, `secret/`.
2. Tab **Startup**:

   | Variable | Nilai | Catatan |
   | --- | --- | --- |
   | `MONGODB_URI` | `mongodb+srv://…/ocean` | **wajib** |
   | `PREFIX` | `o` | prefix default |
   | `CLUSTERS` | `1` | 1–2 untuk panel kecil |
   | `DEBUG` | `false` | `true` = hanya guild di `DEBUG_WHITELIST` |
   | `BOT_STATUS` | `online` | |
   | `BOT_ACTIVITY_TYPE` | `watching` | |
   | `BOT_ACTIVITY_TEXT` | `discord.gg/666family` | |

3. `BOT_TOKEN` boleh di Startup Variables **atau** di file `.env`
   (contoh lengkap: `.env.example`).
4. Startup command: `node index.js`
5. Tekan **Start**. Console yang sehat berisi:

   ```
   [MONGO] connected — mongodb+srv://***@cluster0.abcde.mongodb.net/ocean
   config: prefix="o" — "ohelp" and "o help" both parse, other prefixes are ignored
   [BOOT] running build <hash>
   [GATEWAY] stage connect_called
   [STATE] BOT_ONLINE
   [STATE] PRESENCE_SYNCHRONIZED — status=online watching "discord.gg/666family"
   ```

6. Di Discord: `ohelp`, `o daily`, `obalance`.

---

## 5. Perintah untuk mengecek sendiri

```bash
node index.js --doctor        # cek token, intent, MongoDB, presence (aman dijalankan)
node scripts/verifyDatabase.js  # uji tulis/baca database asli (bot sebaiknya stop)
node index.js --verify        # pastikan semua command ter-load
npm test                      # 239 unit test
```

`verifyDatabase.js` menulis data uji dengan akun palsu
(`999999999999999999`), memeriksa ekonomi, inventory, battle, giveaway, quest,
XP/ranking, prefix, cooldown, lalu **menghapusnya lagi**.

---

## 6. Command yang diuji

Diuji otomatis (`npm test` + `scripts/verifyDatabase.js`):

| Area | Command / alur yang diperiksa |
| --- | --- |
| Prefix | `ohelp`, `o help`, prefix custom per server (`o prefix !`), `thelp` diabaikan |
| Ekonomi | `obalance`/`ocowoncy`, `odaily`, transfer antar user, belanja tervalidasi |
| Inventory | `oinventory`, tambah hewan, `osell`, `osacrifice`, box/crate |
| Battle | `obattle`, `opet team`, `oweapon`, expiry battle (`TIMESTAMPDIFF`) |
| Giveaway | insert/update `giveaway`, pemenang |
| Quest | `o quest`, progres harian |
| XP & ranking | `olevel`, `otop`, `ome` (sorted set XP global + per server) |
| Cooldown | `odaily` sekali sehari, cooldown per command |
| Lain-lain | `o stats`, `o ping`, `o invite`, `o help`, `o prefix`, `o guildlink` |

Semua 285 command (526 alias) tetap terdaftar — tidak ada yang dihapus.

---

## 7. Cara kerja database (singkat)

Dulu bot memakai MySQL + Redis. Sekarang:

- **Tabel SQL → collection MongoDB.** Nama tabel, kolom, primary key, unique
  key dan index tetap sama; definisinya dibaca dari
  `secret/CREATE-OWO-TABLES.sql`.
- `src/utils/mongo/sql/` menerjemahkan statement SQL yang sudah ada di command
  (SELECT/INSERT/UPDATE/DELETE, JOIN, subquery, `ON DUPLICATE KEY UPDATE`,
  `TIMESTAMPDIFF`, …) menjadi operasi MongoDB. Jadi ~350 pemanggilan query di
  command tidak perlu ditulis ulang, tapi datanya murni MongoDB.
- **Redis → collection `_kv`.** Hash (`HGET/HSET/HINCRBY`), sorted set (XP),
  set (opt-out), counter dan TTL semuanya jadi dokumen MongoDB dengan update
  atomik (`$inc`), jadi dua cluster tidak bisa "menghilangkan" cowoncy.
- **Pub/sub antar cluster → collection `_pubsub`** (untuk shutdown/pause).

Detail teknis: `src/utils/mongo/` (`client.js`, `schema.js`, `store.js`,
`sql/parser.js`, `sql/executor.js`), `src/utils/kv.js`, `src/utils/redis.js`,
`src/utils/mysql.js`, `src/botHandlers/mysqlHandler.js`.

---

## 8. Kalau ada masalah

| Gejala di console | Arti & solusi |
| --- | --- |
| `MONGODB_URI is not set` | isi Startup Variable `MONGODB_URI` |
| `MONGODB_URI uses an unsupported scheme "mysql:"` | masih URL MySQL; ganti ke `mongodb+srv://…` |
| `could not connect … after 5 attempt(s)` | user/password salah, IP belum di-allow, atau nama cluster salah |
| `MONGODB_URI has no username:password` | format harus `mongodb+srv://USER:PASS@host/db` |
| Bot online tapi command diam | Message Content Intent belum ON di Developer Portal, atau `DEBUG=true` dengan whitelist kosong |
| `Could not find captcha.js` | normal (file itu tidak ada di repo) |
| `InfluxDB is inactive` | normal, integrasi opsional |

Untuk melihat pesan berhenti di langkah mana:

```
COMMAND_DEBUG=true
```

lalu kirim `ohelp`. Console akan menampilkan:

```
[CMD] message_received — at=guild=… author=… content=ohelp
[CMD] prefix_matched   — prefix=o source=default command=help
[CMD] command_parsed   — command=help registered=true
[CMD] command_executed — command=help phase=start / phase=done
[CMD] rejected — reason=debug_whitelist | prefix_not_matched | rules_not_accepted | …
```

---

## 9. Backup

MongoDB Atlas M0 gratis **tidak** punya backup otomatis. Cara manual:

```bash
mongodump --uri="mongodb+srv://ocean:PASSWORD@cluster0.abcde.mongodb.net/ocean" --out backup-$(date +%F)
```

atau lewat Atlas → **Clusters → ... → Command Line Tools**. Simpan file dump
di luar folder server.

---

## 10. Lisensi

CC-BY-NC-SA-4.0, lihat `LICENSE`. Kredit asli: Christopher Thai (OwO Bot).
Dokumentasi lain: `PTERODACTYL.md` (deploy), `FIXLOG.md` (riwayat perbaikan),
`COMMANDS.md` (daftar command), `SECURITY.md`.
