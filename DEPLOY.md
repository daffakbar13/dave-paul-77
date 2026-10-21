# Deploy DavePaul77

Server (API) ke **Render**, web ke **Vercel**, database tetap **MongoDB Atlas**. Semua lewat website masing-masing;
tidak ada CLI yang wajib. Urutannya penting: Render dulu (web butuh URL API), lalu Vercel, lalu kembali ke Render untuk CORS,
terakhir MT4/MT5.

Waktu: sekitar 20 menit.

---

## 0. Siapkan nilai rahasia (di laptop)

Isi semua nilai ini **hanya** di dashboard Render, jangan di repo.

| Variabel | Cara dapat |
| --- | --- |
| `MONGODB_URI` | Atlas > Database > Connect > Drivers. Bentuknya `mongodb+srv://USER:PASS@CLUSTER.mongodb.net/` |
| `JWT_SECRET` | acak panjang: `openssl rand -base64 48` |
| `ADMIN_PASSWORD_HASH` | password web baru: `cd server && npm run hash-password -- 'password-anda'` |
| `EA_DATA_KEY` | **pakai nilai yang sama** dengan `server/.env` lokal, supaya `DavePaul77.ini` di MT4 cukup diganti URL-nya |

Key akun MT5 tidak perlu diubah: tersimpan sebagai hash di Atlas, jadi baris `Key.<login>` di `DavePaul77.ini` MT5 tetap
berlaku di server Render.

---

## 1. MongoDB Atlas: izinkan Render

Render (paket gratis/Starter) tidak punya IP tetap.

1. Atlas > **Security > Network Access** > **Add IP Address**.
2. Pilih **Allow access from anywhere** (`0.0.0.0/0`) > Confirm.
3. Keamanan tetap dari user/password database di `MONGODB_URI`; pastikan password database kuat.

Database `dave_paul_77` yang dipakai lokal ikut dipakai Render: candle, garis manual, akun, dan pengaturan langsung tersedia.

---

## 2. Render: API (`server/`)

1. https://dashboard.render.com > **New** > **Web Service** > **Build and deploy from a Git repository**.
2. Hubungkan GitHub, pilih repo `dave-paul-77`.
3. Isi:

| Field | Nilai |
| --- | --- |
| Name | `dave-paul-77` (URL jadi `https://dave-paul-77.onrender.com`, atau dengan akhiran acak jika nama sudah dipakai) |
| Region | Singapore (paling dekat WIB) |
| Branch | `main` |
| Root Directory | `server` |
| Runtime | Node |
| Build Command | `npm ci --include=dev && npm run build` |
| Start Command | `npm start` |
| Instance Type | lihat catatan di bawah |

4. **Advanced > Environment Variables**:

| Key | Value |
| --- | --- |
| `NODE_VERSION` | `22.20.0` |
| `MONGODB_URI` | dari langkah 0 |
| `MONGODB_DB` | `dave_paul_77` |
| `JWT_SECRET` | dari langkah 0 |
| `ADMIN_PASSWORD_HASH` | dari langkah 0 (tempel apa adanya, termasuk tanda `$`) |
| `EA_DATA_KEY` | dari langkah 0 |
| `CORS_ORIGIN` | sementara `http://localhost:5173`; diganti di langkah 4 |
| `NEWS_SOURCE` | `forexfactory` |
| `MONGOMS_DISABLE_POSTINSTALL` | `1` (melewati unduhan MongoDB uji ~100 MB saat build) |

`PORT` tidak perlu diisi; Render mengisinya sendiri.

5. **Advanced > Health Check Path**: `/api/health`.
6. **Create Web Service**. Tunggu log `API listening on ...` lalu status **Live**.
7. Cek di browser: `https://<url-render>/api/health` harus menampilkan `{"ok":true}`.

**Instance type**

- **Free**: tidur setelah 15 menit tanpa request; request pertama setelah tidur butuh 30 sampai 60 detik. Selama EA MT4/MT5
  menyala, polling-nya membuat server tetap bangun. EA sudah memakai timeout 30 detik dan mencoba lagi. Kuota 750 jam/bulan
  cukup untuk satu layanan 24 jam.
- **Starter** ($7/bulan): tidak pernah tidur. Disarankan bila web dibuka pagi hari saat EA mungkin belum menyala.

---

## 3. Vercel: web (`web/`)

1. https://vercel.com/new > **Import Git Repository** > pilih `dave-paul-77`.
2. Isi:

| Field | Nilai |
| --- | --- |
| Project Name | `dave-paul-77` |
| Framework Preset | Vite (terdeteksi otomatis) |
| Root Directory | `web` (klik Edit) |
| Build Command | `npm run build` (default) |
| Output Directory | `dist` (default) |

3. **Environment Variables**: `VITE_API_URL` = URL Render **tanpa** `/` di akhir, mis. `https://dave-paul-77.onrender.com`.
4. **Deploy**. Catat domain hasilnya, mis. `https://dave-paul-77.vercel.app`.

`VITE_API_URL` dibaca saat build: jika nanti URL Render berubah, ubah variabelnya lalu **Redeploy** di Vercel.

---

## 4. Render: izinkan domain Vercel (CORS)

1. Render > service `dave-paul-77` > **Environment** > ubah `CORS_ORIGIN` menjadi domain Vercel, mis.
   `https://dave-paul-77.vercel.app`. Beberapa domain dipisah koma (mis. tambah custom domain atau `http://localhost:5173`
   jika masih ingin web lokal memakai API Render).
2. **Save Changes**: Render deploy ulang otomatis.
3. Buka domain Vercel > login dengan password baru > chart dan tab pair harus tampil. Jika muncul error jaringan, cek
   `CORS_ORIGIN` sama persis dengan domain (https, tanpa `/` di akhir).

---

## 5. MT4 dan MT5: arahkan EA ke Render

Untuk kedua terminal:

1. **Tools > Options > Expert Advisors > Allow WebRequest for listed URL**: tambahkan URL Render.
2. Ganti baris `ServerUrl=` di `DavePaul77.ini` ke URL Render:
   - MT4: `MQL4/Files/DavePaul77.ini` (File > Open Data Folder).
   - MT5: `MQL5/Files/DavePaul77.ini`.
   `DataKey` dan `Key.<login>` tetap.
3. Pasang ulang EA (Remove lalu seret lagi) supaya file ini terbaca ulang.
4. Tab Experts: `DavePaul77: server https://...onrender.com` dan baris candle/bid-ask terkirim (MT4), status akun (MT5).

Jika `ServerUrl` diisi di input EA, input itu menang atas file ini: kosongkan inputnya atau ganti ke URL Render.

---

## 6. Cek akhir

- [ ] `https://<render>/api/health` → `{"ok":true}`
- [ ] Web Vercel: login berhasil, chart tampil
- [ ] Di bawah chart: "MT4 terakhir kirim … lalu (server broker UTC+…)"
- [ ] Toolbar: balance akun MT5 "sinkron … lalu"
- [ ] Pending Orders > Kandidat terisi; Execute dengan `DryRun = true` dulu, cek tab Perintah ke MT5: "Berhasil · dry-run"

---

## Pemakaian harian dan perawatan

- Setiap push ke `main` membuat Render dan Vercel deploy ulang otomatis.
- Ganti password web: buat hash baru (langkah 0) > Render > `ADMIN_PASSWORD_HASH` > Save.
- Ganti `EA_DATA_KEY`: ubah di Render, lalu `DataKey` di `MQL4/Files/DavePaul77.ini`, pasang ulang EA MT4.
- Key akun MT5 baru: web > Pengaturan > Akun MT5 > Buat key EA baru > tambah/ubah baris `Key.<login>` di
  `MQL5/Files/DavePaul77.ini`.
- ngrok tidak dibutuhkan lagi setelah deploy.

## Masalah umum

| Gejala | Penyebab |
| --- | --- |
| Build Render gagal `tsc: not found` | Build command harus `npm ci --include=dev && npm run build` |
| Render log `Missing environment variable ...` | Variabel di langkah 2 belum diisi |
| Render log `MongoServerSelectionError` | Network Access Atlas belum `0.0.0.0/0`, atau `MONGODB_URI` salah |
| Web: "Password salah." | `ADMIN_PASSWORD_HASH` bukan hash dari password yang dicoba; buat ulang |
| Web: request gagal/CORS di console | `CORS_ORIGIN` tidak sama persis dengan domain Vercel |
| MT4/MT5 log error 4060 / 4014 | URL Render belum ada di Allow WebRequest |
| MT4/MT5 log `HTTP 401` | `DataKey` / `Key.<login>` tidak cocok dengan server |
| Request pertama pagi hari lambat | Render Free sedang bangun; tunggu ±1 menit atau pakai Starter |
