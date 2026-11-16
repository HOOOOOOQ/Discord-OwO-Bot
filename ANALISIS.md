# Analisis Teknis & Status Perbaikan — Discord-OwO-Bot

> Repo: `HOOOOOOQ/Discord-OwO-Bot` · Branch: `arena/cd799cbe-discord-owo-bot`
> Baseline: `9aec92b` ("Fixed math command + other minor errors") · Diperbarui: 2026-11-16
> Dokumen pendamping: [FIXLOG.md](FIXLOG.md) (root cause + verifikasi per perbaikan),
> [SECURITY.md](SECURITY.md), [TESTING.md](TESTING.md), [DEPLOYMENT.md](DEPLOYMENT.md).

Dokumen ini adalah analisis **sebelum** dan **sesudah** perbaikan. Bagian 9
mencantumkan sisa risiko yang belum diperbaiki beserta alasannya.

---

## 1. Ringkasan

| Metrik                       | Sebelum                                                        | Sesudah                                                        |
| ---------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------- |
| `npm ci` dari clone bersih   | ❌ gagal (`E404` urban-dictionary)                             | ✅ 500 paket, tanpa kredensial SSH                             |
| Advisory dependency (prod)   | 96 (9 critical, 52 high)                                       | 22 (1 critical, 17 high)                                       |
| Paket di lockfile            | 863                                                            | 501                                                            |
| Dependency deprecated kritis | `request`, `safe-eval`, `urban-dictionary`, `express`, `npm@7` | tidak ada                                                      |
| Owner default di config      | ID Discord pengembang asli                                     | kosong (env-only)                                              |
| `debug` default              | `true`                                                         | `false`                                                        |
| `eval`                       | owner-only via ID hardcoded                                    | owner-only + `ALLOW_EVAL` + audit + redaksi                    |
| Error pada satu command      | mematikan cluster                                              | ditangani, dibalas sekali, dilanjutkan                         |
| Transaksi MySQL              | `throw` di callback + race                                     | berurutan, idempoten, release sekali                           |
| Test otomatis                | 0                                                              | 59 (unit + regresi)                                            |
| Verifikasi registry          | tidak ada                                                      | 284 instance / 522 alias / 0 masalah                           |
| CI                           | Node 15, lint, master-only                                     | Node 20 & 22, lint+test+registry+circular+install native+audit |
| Logging                      | 188 `console.*` tanpa konteks                                  | terstruktur, bertimestamp, ber-cluster, teredaksi              |

---

## 2. Arsitektur (dipertahankan)

```
index.js (master) ── dotenv ── utils/config.js (env override + validasi)
   │                └── errors.installProcessHandlers() + graceful shutdown
   ├── fetchInitWithRetry() → SHARDER_HOST (3x backoff)
   └── eris-sharder Master → CLUSTERS (default 60) cluster proses
          └── src/owo.js (Base)
                ├── utils/mysql.js  (pool, error listener, timeout, close())
                ├── utils/redis.js  (retry_strategy, quit)
                ├── utils/log.js    (structured + redaction + console bridge)
                ├── utils/errors.js (wrapAsync, runCommandSafely, shutdown)
                ├── utils/metrics.js(counter nyata, StatsD opsional)
                ├── eventHandlers/* (16 handler, dibungkus safety net)
                ├── interactionHandlers (button + app commands)
                └── commands/command.js (require-dir, 284 instance, 522 alias)
                       ├── auth.canRunAdmin() → owner/role/mod-channel
                       └── execute → ban → cooldown → command → metrics
```

Semua komponen, perintah, alias, tabel (87), integrasi API, dan arsitektur
60-cluster **tidak diubah**. Perbaikan bersifat aditif: modul baru di
`src/utils/`, pembungkusan pada titik masuk, dan penggantian dependency yang mati
dengan implementasi yang setara.

---

## 3. Temuan keamanan (status)

| Temuan                                        | Dampak awal                            | Status                                                                       |
| --------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------- |
| Owner ID pengembang di config                 | fork mewarisi akses `eval`/`giveall`   | ✅ diperbaiki (`OWNER_IDS`, kosong = ditolak)                                |
| `debug: true` ter-commit + whitelist 5 ID     | bot diam di server baru                | ✅ `DEBUG=false`, whitelist via `DEBUG_WHITELIST`                            |
| `eval` tanpa guard                            | RCE oleh siapa pun yang dianggap owner | ✅ `ALLOW_EVAL` + audit + shadowing + redaksi                                |
| `request@2.88` (SSRF), `safe-eval` (breakout) | rantai serangan dari input             | ✅ dihapus, diganti `src/utils/http.js`                                      |
| Interpolasi SQL pada 5 query                  | SQLi jika ada titik lolos validasi     | ✅ parameterized                                                             |
| `multipleStatements: true`                    | injeksi jadi stacked query             | ⚠️ dipertahankan (dibutuhkan fitur battle), dikonfigurasi + didokumentasikan |
| `throw` di callback HTTP/DB                   | proses mati saat InfluxDB/DB down      | ✅ dihapus                                                                   |
| `tar` via `canvas@2` (critical)               | build-time                             | ⚠️ butuh migrasi canvas 3                                                    |

Detail mitigasi ada di `SECURITY.md`.

---

## 4. Stabilitas & bug konkret (status)

| Bug                                                    | Status                             | Bukti                                       |
| ------------------------------------------------------ | ---------------------------------- | ------------------------------------------- | --- | ------ |
| `messageCreate` tanpa `await`/`catch` → cluster mati   | ✅ safety net berlapis             | `test/commandInterface.test.js`             |
| `executeCommand` tanpa `try/catch`                     | ✅                                 | idem                                        |
| `startTransaction`: `throw` di callback + race         | ✅ lifecycle baru                  | `test/mysqlHandler.test.js` (8 test)        |
| `mysql.createPool` tanpa listener `error`              | ✅                                 | `src/utils/mysql.js`                        |
| `math` timeout 3000 vs pesan "1000 ms"                 | ✅ `classifyMathError()`           | `test/mathResult.test.js`                   |
| `math` pool di-`terminate()` tiap request              | ✅ pool dipakai ulang              | review + test                               |
| `mathWorker.js` dipanggil loader → merusak IPC cluster | ✅ guard `isWorkerProcess`         | `npm run verify:commands`                   |
| `REGITER_COMMANDS` typo                                | ✅ dua nama didukung               | review                                      |
| `guild?.id \| 'dm'` (bitwise OR)                       | ✅ `                               |                                             | `   | review |
| `covid.js` request saat module load                    | ✅ guard `SHARDER_HOST`            | verifikasi registry tanpa `ERR_INVALID_URL` |
| Metrik di-`stub` dengan `return;`                      | ✅ counter nyata + StatsD opsional | `src/utils/metrics.js`                      |
| Tidak ada graceful shutdown                            | ✅ hook SIGTERM/SIGINT             | `src/utils/errors.js`                       |

---

## 5. Dependency

| Sebelum                                                                                 | Sesudah                                                              |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `urban-dictionary` (unpublished)                                                        | `src/utils/urbanDictionary.js` (API publik yang sama)                |
| `request` (24 file)                                                                     | `src/utils/http.js` (fetch + timeout)                                |
| `weeb.js`                                                                               | `src/utils/weeb.js` (api.weeb.sh langsung)                           |
| `translate-google` (+`safe-eval`)                                                       | `src/utils/translate.js`                                             |
| `axios@0.21.4`                                                                          | `axios@1.21.1` (API kompatibel)                                      |
| `systeminformation@5.12`                                                                | `5.33.23`                                                            |
| `canvas@2.6`                                                                            | `canvas@2.11.2`                                                      |
| `express`, `install`, `npm@7`, `novelcovid`, `erlpack`, `zlib-sync`, `ws`, `bufferutil` | dihapus (tidak direferensikan; `compress:false`)                     |
| Git dependency via `git+ssh`                                                            | URL `https://github.com/...` eksplisit; `npm ci` tidak butuh SSH key |

Sisa 22 advisory beserta alasan tidak di-upgrade ada di `SECURITY.md`.
`npm audit fix --force` **tidak** dipakai.

---

## 6. Database

- 87 tabel, 230 index — tidak ada perubahan schema, tidak ada migrasi destruktif.
- `acceptedRules`, `rep`, `cowoncy`, `user_ring`, `autohunt` → parameterized.
- Transaksi: resolve setelah `beginTransaction`, `commit`/`rollback` idempoten,
  release tepat sekali, rollback otomatis pada kegagalan commit atau lease
  timeout (10s, `MYSQL_TRANSACTION_TIMEOUT_MS`).
- Query memiliki timeout klien (`MYSQL_QUERY_TIMEOUT_MS`, default 30s).
- `connectionLimit`, `connectTimeout`, `maxIdle`, `idleTimeout` dapat diatur env;
  ingat `CLUSTERS × MYSQL_CONNECTION_LIMIT ≤ max_connections`.

---

## 7. Testing & CI

- `npm test` → 59 test (config, auth, log, sandbox, http, mysqlHandler,
  commandInterface, registry, urbanDictionary, translate, mathResult).
- `npm run verify:commands` → memuat seluruh registry lewat loader asli:
  284 instance, 522 alias, 0 masalah, 7 alias "shadowed" yang sudah ada sejak
  sebelum perbaikan (didokumentasikan di FIXLOG).
- CI: Node 20 & 22; lint, prettier, test, registry, circular; job terpisah untuk
  `npm ci` penuh dengan library canvas; audit bersifat _report-only_ dan tidak
  pernah diam-diam hijau.

---

## 8. Risiko operasional yang perlu disadari

1. **Multi-statement SQL** masih aktif (kebutuhan fitur battle/zoo). Jalankan user
   database dengan hak minimum; matikan setelah call site dimigrasi.
2. **`ALLOW_EVAL`** memberi RCE ke pemegangnya. Biarkan `false` di produksi.
3. **60 cluster per host** = 60 proses + pool DB masing-masing; sesuaikan
   `CLUSTERS`/`MYSQL_CONNECTION_LIMIT`.
4. **`canvas`** satu-satunya dependency native; sudah dibuat `optionalDependencies`, jadi tanpa toolchain `npm ci` tetap sukses dan hanya command memegen yang nonaktif
   (disediakan Dockerfile dan job CI khusus).
5. **Layanan internal** (`SHARDER_HOST`, image-gen) wajib untuk produksi; tanpa
   itu `index.js` berhenti dengan pesan jelas (bukan crash acak).

---

## 9. Utang teknis yang tersisa

| Item                                                               | Alasan belum dikerjakan                                  | Rekomendasi                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------- |
| `mysql@2.18` → `mysql2`                                            | perbedaan tipe/tanggal di 87 tabel, tanpa test integrasi | migrasi bertahap + test integrasi DB        |
| `redis@2.8` → `4.x`                                                | API callback dipakai di seluruh `redis.js`               | migrasi bersama `mysql2`                    |
| `dd-trace@0.31` → `6.x`                                            | perubahan perilaku APM                                   | upgrade terpisah, ukur dampak               |
| `canvas@2` → `3`                                                   | breaking untuk semua command gambar                      | spike terpisah, hilangkan critical `tar`    |
| `mathjs@6` → `15`                                                  | mesin dipakai `owo math`                                 | upgrade + uji ekspresi                      |
| 742 perbandingan `==`, 63 `var`                                    | perubahan massal, berisiko                               | aktifkan `eqeqeq`/`no-var` bertahap         |
| 188 `console.*`                                                    | sudah distandarkan lewat bridge                          | migrasi ke `log.create(scope)` per modul    |
| 7 alias collectible ganda                                          | dua implementasi paralel (JSON vs class)                 | putuskan satu implementasi, hapus yang lain |
| File 1.000+ baris (`me.js`, `weaponUtil.js`, `WeaponInterface.js`) | risiko regresi                                           | pecah per tanggung jawab setelah ada test   |
| `secret/` memuat file "rahasia" yang publik                        | bukan rahasia sebenarnya                                 | dokumentasikan, jangan taruh token di sana  |

---

## 10. Cara memverifikasi ulang

```bash
npm ci                # butuh toolchain canvas (lihat DEPLOYMENT.md)
npm run lint
npm run prettier
npm test
npm run verify:commands
npm run checkCircular
npm audit --omit=dev
git diff --check
```

Angka dan klaim di dokumen ini berasal dari eksekusi perintah di atas pada
branch ini — bukan perkiraan. Yang **tidak** dieksekusi di lingkungan ini:
`npm ci` penuh dengan native build (tidak ada libcairo di sandbox) dan sesi
gateway Discord (butuh token); keduanya tersedia sebagai job CI/tahap deploy.
