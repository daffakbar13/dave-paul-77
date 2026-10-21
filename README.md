# DavePaul77 (dave-paul-77)

Aplikasi bantu trading forex: garis support/resistance D1 otomatis, kandidat buy/sell stop dengan SL, TP dan lot,
lalu eksekusi ke MT5 lewat EA setelah Confirm. Konsep: dokumen konsep versi 1, 21 Okt 2026 (tidak disertakan di repo).

| Folder    | Isi                                                                 | Deploy  |
| --------- | ------------------------------------------------------------------- | ------- |
| `server/` | Node.js + Express + MongoDB: analisa, order, antrean perintah, API EA | Render  |
| `web/`    | React + Vite + lightweight-charts: chart, Pending Orders, Execute     | Vercel  |
| `ea/`     | EA MT4 data (tahap 2), EA MT5 eksekutor (tahap 4); lihat `ea/README.md` | MT4/MT5 |

## Tahap 1: backend dan web (data contoh)

- Engine S/R: `server/src/analysis/sr.ts` (fraktal, cluster ATR, candle kuat, pantulan, entry/SL/TP, TP auto, dedup entry).
- Lot dan validasi: `server/src/analysis/orders.ts` (lot dibulatkan ke bawah, stops level, harga lewat entry, lot minimum, risk per mata uang).
- Uji otomatis: `cd server && npm test`.
- Endpoint EA (`/api/ea/mt4/*`, `/api/ea/mt5/*`) sudah ada dan teruji dengan curl; EA-nya dibuat di tahap 2 dan 4.

## Menjalankan di laptop

Tanpa MongoDB lokal: server memakai MongoDB in-memory yang langsung diisi data contoh (hilang saat dihentikan).

```bash
cd server && npm install && npm run dev:memory
```

```bash
cd web && npm install && npm run dev
```

Buka http://localhost:5173, password `admin`. Data contoh: 15 pair sintetis (GBPUSD dan XAUUSD nonaktif), akun
Demo A (10.000 USD) dan Demo B (5.000 USD, suffix `.m`, balance "lama"). Key EA contoh ada di `server/src/sample.ts`.

Dengan MongoDB sungguhan: salin `server/.env.example` ke `server/.env`, isi, lalu `npm run seed -- --force` (opsional) dan `npm run dev`.

## Deploy

**Render** (web service, Root Directory `server`): build `npm ci && npm run build`, start `npm start`, health check `/api/health`.
Environment: `MONGODB_URI`, `MONGODB_DB`, `JWT_SECRET`, `ADMIN_PASSWORD_HASH` (`npm run hash-password -- 'password'`),
`EA_DATA_KEY`, `CORS_ORIGIN` (domain Vercel).

**Vercel** (Root Directory `web`): framework Vite, environment `VITE_API_URL` = URL Render.

**MT4/MT5**: Tools, Options, Expert Advisors: centang Allow WebRequest, daftarkan URL Render.

## Tahap 2: data MT4 dan kalibrasi

- **EA MT4**: `ea/DavePaul77Data.mq4`, cara pasang di `ea/README.md`. Daftar pair diambil dari Pengaturan > Pair.
- **Kalibrasi** (tombol Kalibrasi di toolbar): masukkan order manual (pair, tipe, entry, SL, TP, tanggal pasang).
  Aplikasi menghitung analisa dengan candle sebelum tanggal itu dan menampilkan selisih entry/SL/TP dalam ATR.
  Cocok jika entry ≤ 0,2 ATR dan SL ≤ 0,3 ATR. **Cari parameter terbaik** mencoba 972 kombinasi
  (penggabungan area, sentuhan, candle kuat, wick, buffer, pilihan candle kuat) dan bisa langsung diterapkan.
- Logika: `server/src/analysis/calibrate.ts` (dengan test).

## Catatan kalibrasi

Dengan aturan default, data 2 tahun menghasilkan banyak garis (20 sampai 30 per pair), dan TP = garis berikutnya
sering memberi RR di bawah 1:1,5. Karena itu ada pengaturan **Maks garis berorder per sisi** (default 3: hanya 3 garis
terdekat di atas dan di bawah harga yang diberi order; semua garis tetap dipakai sebagai TP). Isi 0 untuk semua garis.
Parameter lain (penggabungan area, candle kuat, pantulan, pilihan candle kuat paling baru atau paling dekat) dikalibrasi
dengan contoh order manual.
