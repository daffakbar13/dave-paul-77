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

Dengan EA MT4 sungguhan tanpa data contoh: `npm run dev:memory -- --empty` plus ngrok (lihat `ea/README.md`).

Dengan MongoDB sungguhan: salin `server/.env.example` ke `server/.env`, isi, lalu `npm run seed -- --force` (opsional) dan `npm run dev`.

## Deploy

Panduan langkah demi langkah lewat website (Render, Vercel, Atlas, lalu arahkan EA): [DEPLOY.md](DEPLOY.md).

## Tahap 2: data MT4 dan kalibrasi

- **EA MT4**: `ea/DavePaul77Data.mq4`, cara pasang di `ea/README.md`. Daftar pair diambil dari Pengaturan > Pair.
- **Kalibrasi** (tombol Kalibrasi di toolbar): masukkan order manual (pair, tipe, entry, SL, TP, tanggal pasang).
  Aplikasi menghitung analisa dengan candle sebelum tanggal itu dan menampilkan selisih entry/SL/TP dalam ATR.
  Cocok jika entry ≤ 0,2 ATR dan SL ≤ 0,3 ATR. **Cari parameter terbaik** mencoba 972 kombinasi
  (penggabungan area, sentuhan, candle kuat, wick, buffer, pilihan candle kuat) dan bisa langsung diterapkan.
- Logika: `server/src/analysis/calibrate.ts` (dengan test).

## Tahap 3: kalender ekonomi dan Aggressive otomatis

- **Sumber**: feed mingguan ForexFactory (`nfs.faireconomy.media/ff_calendar_thisweek.json`). Gratis, tanpa key, hanya
  minggu berjalan, jam dalam ISO dengan offset New York (ditampilkan dalam WIB). Diambil paling sering sekali per jam
  hari kerja, 12 jam saat akhir pekan (10 menit setelah gagal), saat web dibuka; jika gagal, data terakhir tetap dipakai dan banner menampilkan errornya.
  Bisa diganti lewat `NEWS_SOURCE` (`forexfactory`, `sample` atau `none`); provider ada di `server/src/news.ts`.
  `npm run dev:memory` selalu memakai `sample` (berita contoh tetap) agar restart lokal tidak kena rate limit
  feed; tambahkan `-- --live-news` untuk memakai feed sungguhan.
- **Banner**: berita merah (High) dari 1 jam lalu sampai jendela ke depan (default 24 jam), dengan jam rilis WIB.
- **Aggressive**, tiga mode per sesi browser:
  - *auto* (setiap aplikasi dibuka): pengali akun berlaku untuk pair yang mata uangnya punya berita merah di jendela,
    hanya untuk akun dengan "Aggressive otomatis" menyala. Pair terkait diberi tanda `!` di tab.
  - klik saat aktif: *mati* untuk sesi itu; klik lagi: *manual* untuk semua pair.
- Batasan: feed tidak memuat minggu depan, jadi berita Senin baru muncul setelah feed berganti minggu (akhir pekan).

## Tahap 4: EA MT5 eksekutor

`ea/DavePaul77Exec.mq5` (lihat `ea/README.md`): lapor balance dan spesifikasi simbol, ambil perintah akun yang login,
hapus pending order ber-magic number lalu pasang yang baru, lapor hasil per order. DryRun default menyala. Hasil
terlihat di Pending Orders > Perintah ke MT5 (status, dry-run, berhasil/gagal, order lama yang dihapus).
Urutan uji: dry-run (selesai) → akun demo live → live.

## Jurnal trade dan audit bulanan

EA eksekutor v1.10 melapor deal posisi ber-magic number (fill, SL, TP, stop out, tutup manual, partial close). Server
menyimpan satu dokumen per order live (`trades`, tiket order = ID posisi) dengan salinan rencananya saat Execute (garis
manual/otomatis, entry, SL, TP, lot, risk, RR, sumber SL, multiplier Aggressive, berita), jadi tetap utuh setelah
perintah dihapus 30 hari. Order yang diganti Execute berikutnya sebelum ter-fill berstatus dibatalkan.

Tombol **Jurnal**: per akun dan bulan (trade dihitung di bulan close-nya, WIB) — trade, win rate, net, profit factor,
rata-rata R (net / risk rencana), max drawdown, fill rate per level, slippage fill terhadap entry rencana dalam R, temuan
otomatis, rincian per pair / alasan close / Normal-Aggressive / sumber SL / RR / garis / arah, tabel trade, posisi
terbuka, dan Unduh CSV (bahan audit bulanan).

## Model order tangga dan garis manual (22 Okt 2026)

Dianalisa dari history MT5 akun 12345678 (4.622 pending order, September 2026) terhadap garis S/R yang digambar user
sendiri (template `.tpl` di folder template chart user):

- **Garis**: mesin yang menentukan garis (fraktal 2, gabung 0,3 ATR, minimal 2 sentuhan). Garis user (import `.tpl` di
  Pengaturan > Pair, atau dikirim EA MT4 dari garis horizontal di chart) hanya **referensi**: tampil samar di chart dan
  dipakai di **Kalibrasi > Garis** (presisi, recall, F1 per pair dengan toleransi 0,25 ATR, plus pencarian fraktal /
  penggabungan / sentuhan). Pengaturan > Analisa S/R > *Garis untuk order* bisa dikembalikan ke garis user.
- **Order per garis** (g = jarak ke garis berikutnya searah order): entry = garis + 0,22·g, SL = garis − 0,16·g (seberang
  garis yang sama), TP = garis berikutnya − 0,07·g; garis terakhir: TP = RR 1,5. RR sekitar 1,9 di semua jarak garis.
- **SL minimal** per pair dalam pips (10/15/20/30, dari alat order lama), bisa diubah di Pengaturan > Pair.
- **Per sisi** 6 garis terdekat dari harga; garis yang lebih dekat dari 0,3 ATR ke harga dilewati.
- **Validasi** (replay 224 setup pair, 3.555 order): entry dalam 0,1 ATR 84,5%, SL dalam 0,1 ATR 75,8%, TP dalam 0,15 ATR
  90,1%. Model candle kuat lama: 10,3% / 6,6% / 13,6%. Model candle kuat tetap bisa dipilih di Pengaturan > Analisa S/R.

## Catatan kalibrasi

Dengan aturan default, data 2 tahun menghasilkan banyak garis (20 sampai 30 per pair), dan TP = garis berikutnya
sering memberi RR di bawah 1:1,5. Karena itu ada pengaturan **Maks garis berorder per sisi** (default 3: hanya 3 garis
terdekat di atas dan di bawah harga yang diberi order; semua garis tetap dipakai sebagai TP). Isi 0 untuk semua garis.
Parameter lain (penggabungan area, candle kuat, pantulan, pilihan candle kuat paling baru atau paling dekat) dikalibrasi
dengan contoh order manual.
