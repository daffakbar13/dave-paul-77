# EA DavePaul77

## DavePaul77Data.mq4 (MT4, data)

Mengirim candle D1 yang sudah close dan bid/ask pair aktif ke backend. Digerakkan timer (cek tiap 5 detik), tidak
pernah membuka order.

**Pasang**

1. Salin `DavePaul77Data.mq4` ke folder `MQL4/Experts` (MT4: File > Open Data Folder), lalu compile di MetaEditor (F7).
2. Tools > Options > Expert Advisors: centang **Allow WebRequest for listed URL**, tambahkan URL Render
   (mis. `https://dave-paul-77.onrender.com`).
3. Pasang EA di **satu** chart saja (pair dan timeframe bebas). Tombol AutoTrading tidak wajib karena EA ini tidak trading.
4. Parameter:

| Parameter | Isi |
| --- | --- |
| `ServerUrl` | kosongkan untuk memakai `DavePaul77.ini`; atau URL server tanpa `/` di akhir |
| `DataKey` | kosongkan untuk memakai `DavePaul77.ini`; atau nilai `EA_DATA_KEY` |
| `SymbolSuffix` | akhiran nama simbol broker di MT4 ini, mis. `m` untuk `EURUSDm`; kosong jika tidak ada |
| `FallbackSymbols` | dipakai hanya jika daftar pair dari server tidak terbaca |
| `HistoryBars` | jumlah candle D1 yang dikirim saat pertama jalan (520 = sekitar 2 tahun) |
| `QuoteSeconds` | jeda kirim bid/ask |
| `TimeoutMs` | 30000; Render paket gratis bisa butuh 30 sampai 50 detik untuk bangun |

**Tanpa mengetik key: `MQL4/Files/DavePaul77.ini`** (File > Open Data Folder > MQL4 > Files)

```
ServerUrl=https://nama-anda.ngrok-free.dev
DataKey=<EA_DATA_KEY dari server/.env>
```

Input yang diisi tetap menang atas file ini. Pindah ke Render cukup dengan mengganti `ServerUrl` di file, lalu pasang ulang EA.

**Garis S/R dari chart**: tiap 60 detik EA membaca garis horizontal di semua chart yang terbuka untuk pair aktif dan
mengirimnya jika berubah (`SendChartLines`, `LinesSeconds`). Pair tanpa chart terbuka dilewati (server menyimpan garis
terakhir); chart tanpa garis mengembalikan pair itu ke garis otomatis.

**Uji lokal lewat ngrok**

1. Di laptop: `cd server && npm run dev:memory -- --empty` (DB in-memory kosong, memakai `server/.env`), lalu
   `ngrok http --url=nama-anda.ngrok-free.dev 4000`.
2. Isi `DavePaul77.ini` seperti di atas dan daftarkan URL yang sama di Allow WebRequest.
3. EA mengirim header `ngrok-skip-browser-warning` agar ngrok gratis tidak membalas dengan halaman peringatan.
4. Data in-memory hilang saat server dihentikan; EA mengirim ulang 520 candle setelah EA di-restart.

**Cara kerja**

- Daftar pair diambil dari Pengaturan > Pair di web (`GET /api/ea/mt4/symbols`) tiap 30 menit, jadi tab dan EA selalu sama.
- Saat pertama jalan, tiap pair mengirim 520 candle D1 tertutup. Setelah itu hanya candle baru setiap pergantian hari broker.
  Histori yang belum terunduh (error 4066) dicoba lagi tiap 60 detik.
- Waktu candle memakai jam server broker. EA ikut mengirim `TimeCurrent()`, jadi server tahu candle sudah close
  dan menampilkan offset broker (mis. "server broker UTC+3") di bawah chart.
- Status di web: "MT4 terakhir kirim … lalu" berwarna oranye jika lebih dari 10 menit.

**Cek di tab Experts / Journal**

- `URL belum diizinkan` (error 4060): URL belum didaftarkan di langkah 2.
- `HTTP 401 ... Invalid data key`: `DataKey` tidak sama dengan `EA_DATA_KEY`.
- `... tidak ada di MT4 ini`: nama pair atau `SymbolSuffix` salah, atau pair belum ada di Market Watch.

## DavePaul77Exec.mq5 (MT5, eksekutor)

Mengambil perintah milik akun yang sedang login, menghapus pending order ber-magic number aplikasi (default 77077),
memasang buy/sell stop baru dengan SL dan TP, lalu melapor hasil per order. Posisi terbuka dan order manual tidak
disentuh. **DryRun menyala secara default**: hanya mencatat apa yang akan dihapus dan dipasang, lalu melapor ke web.

**Pasang**

1. Salin ke `MQL5/Experts`, compile (F7). Tools > Options > Expert Advisors: Allow WebRequest untuk URL server.
2. Buat akun di web (Pengaturan > Akun MT5, nomor = login MT5). Key ditampilkan sekali.
3. `MQL5/Files/DavePaul77.ini`, satu baris key per akun:

```
ServerUrl=https://nama-anda.ngrok-free.dev
Key.12345678=<key akun dari web>
```

4. Pasang EA di satu chart dengan input `ServerUrl`/`AccountKey` kosong. Pindah akun di MT5 tidak perlu ubah apa pun:
   EA membaca `Key.<login>` akun yang sedang login.

| Parameter | Isi |
| --- | --- |
| `DryRun` | `true` sampai hasil di akun demo sesuai tabel; `false` untuk memasang order |
| `MagicNumber` | penanda order aplikasi; hanya order dengan magic ini yang dihapus |
| `PollSeconds` / `StatusSeconds` | ambil perintah tiap 5 detik, lapor balance dan spesifikasi tiap 60 detik |

**Posisi berjalan**: status juga memuat posisi terbuka ber-magic number (dikirim langsung saat ada order tersentuh atau
posisi tutup). Server mencocokkan tiap posisi ke levelnya lewat komentar order (ID level), atau, jika broker mengubah
komentar, lewat harga buka dalam 30% jarak entry ke SL (kebal slippage/spread). Level itu berstatus "Posisi berjalan",
tetap tampil di chart (garis bertitik jarang, label "posisi #tiket") dan tidak dikirim ulang saat Execute.

**Pengaman**

- Mode live dengan Algo Trading mati: perintah tidak diambil (tetap menunggu di server sampai kedaluwarsa).
- Lot dinormalkan ke step broker dan dibulatkan ke bawah.
- Hasil yang gagal terkirim dicoba lagi tanpa memasang order ulang; satu perintah hanya bisa diambil sekali.
- Spesifikasi simbol yang belum punya harga (pasar tutup) dilewati dan dikirim di status berikutnya.
- Simbol yang tidak ada di akun dicatat di log: atur mapping simbol akun di web (mis. `EURUSD=EURUSDm`).

Diuji 22 Okt 2026 di server demo broker (demo): status, spesifikasi 13 pair dan perintah dry-run 48 order
(48 berhasil, 0 gagal) terlapor ke web.
