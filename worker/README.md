# DavePaul77 news worker (Cloudflare)

Cloudflare Worker gratis yang jalan **setiap 5 menit**, tanpa laptop dan tanpa Render:

- Mengambil feed ForexFactory paling sering 4 jam sekali (1 jam sebelum Daily Outlook) dan menyimpannya di KV. Versi
  XML dulu (JSON hampir selalu kena rate limit dari IP Cloudflare yang dipakai bersama), JSON sebagai cadangan.
- **News Alert** (topik grup Telegram): setiap berita *high impact* (semua mata uang) dikirim saat masuk jendela
  24 jam, lalu 4 jam, 1 jam dan 30 menit sebelum rilis. Berita di jam yang sama digabung dalam satu pesan. Tiap tahap
  hanya sekali; jika run telat, hanya tahap terdekat yang dikirim. Jadwal berubah = berita baru, alert mulai lagi.
- **Other News** (topik sendiri, opsional): berita *medium* 🟠 dan *low* 🟡 semua mata uang, sekali 30 menit
  sebelum rilis, digabung per jam rilis. Berita merah tetap hanya di News Alert. Tidak dikirim sebelum
  `TOPIC_OTHER_NEWS` diisi.
- **Daily Outlook** (topik lain): 05:00 WIB, semua berita high impact 05:00 s.d. besok 05:00 WIB. Tidak dikirim hari
  Sabtu (Minggu meliputi Senin pagi). Jika 05:00 gagal, dicoba lagi sampai 08:00.
- Peringatan sekali di News Alert jika kalender gagal diperbarui lebih dari 12 jam, dan pesan saat kembali normal.
- `GET /calendar`: salinan kalender untuk server Render (`NEWS_SOURCE=worker`), jadi Render tidak pernah memanggil
  ForexFactory sendiri.

Log pesan terkirim ada di KV (`sent`), dibersihkan otomatis 2 hari setelah berita rilis. Pemakaian jauh di bawah batas
paket gratis (KV: ±15 tulis/hari dari 1.000).

## Setup (sekali, ±15 menit)

### 1. Bot dan grup Telegram

1. Token bot dari @BotFather. Token yang pernah ditempel di chat/tempat lain: `/revoke` lalu pakai token baru.
2. Grup > Edit > **Topics** nyalakan. Buat topik **News Alert**, **Daily Outlook** dan (opsional) **Other News**.
3. Tambahkan bot ke grup. Jika anggota biasa tidak boleh menulis di topik, jadikan bot admin (cukup izin kirim pesan).
4. Kirim `/id@NamaBotAnda` di **masing-masing** topik.
5. Buka di browser (ganti `<TOKEN>`): `https://api.telegram.org/bot<TOKEN>/getUpdates`
   - `"chat":{"id":-100...}` = **TELEGRAM_CHAT_ID**
   - `"message_thread_id":...` pada pesan di News Alert = **TOPIC_NEWS_ALERT**, di Daily Outlook = **TOPIC_DAILY_OUTLOOK**, di Other News = **TOPIC_OTHER_NEWS**

   Hasil kosong? Kirim ulang `/id@NamaBotAnda`, lalu muat ulang halaman.

### 2. Cloudflare

Akun gratis di https://dash.cloudflare.com, lalu di laptop:

```bash
cd worker
npm install
npx wrangler login
npx wrangler kv namespace create NEWS
```

Id yang dicetak sudah terisi di `wrangler.toml` (bukan rahasia); di akun Cloudflare lain, ganti dengan id baru.

Isi rahasia (diminta satu per satu di terminal, tidak masuk repo):

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put TOPIC_NEWS_ALERT
npx wrangler secret put TOPIC_DAILY_OUTLOOK
npx wrangler secret put TOPIC_OTHER_NEWS
```

Deploy:

```bash
npx wrangler deploy
```

Wrangler mencetak URL: `https://dave-paul-77-news.davepaul77.workers.dev` (deploy pertama meminta subdomain `workers.dev` akun; di sini `davepaul77`).

### 3. Cek

- Run pertama dalam ≤5 menit. Lihat log: `npx wrangler tail` atau dashboard > Workers > dave-paul-77-news > Logs.
  Baris `calendar: N items` = feed berhasil; `sent alert: ...` = pesan terkirim.
- Buka `https://dave-paul-77-news.<akun>.workers.dev/calendar`: `fetchedAt` terisi dan `error` `null`.
- Jika ada berita high impact dalam 24 jam, News Alert langsung menerima pesan pertama.

### 4. Render memakai worker

Render > service `dave-paul-77` > Environment:

| Key | Value |
| --- | --- |
| `NEWS_SOURCE` | `worker` |
| `NEWS_WORKER_URL` | URL worker dari langkah 2, tanpa `/` di akhir |

Save: Render deploy ulang, banner rate limit di web hilang.

## Ubah

- Daftar pair di baris `Pair:`: `PAIRS` di `wrangler.toml`, lalu `npx wrangler deploy`.
- Tes: `npm test`. Coba lokal: `npm run dev`, lalu buka `http://localhost:8787/__scheduled` untuk satu run (butuh
  `.dev.vars` berisi rahasia yang sama; jangan di-commit).

## Masalah umum

| Log | Penyebab |
| --- | --- |
| `send failed ... chat not found` | `TELEGRAM_CHAT_ID` salah (harus diawali `-100`) atau bot belum di grup |
| `send failed ... message thread not found` | `TOPIC_*` salah |
| `send failed ... not enough rights` | Bot belum boleh menulis di topik; jadikan admin |
| `send failed ... Unauthorized` | Token salah atau sudah di-revoke |
| `calendar error: rate limit ...` | ForexFactory membatasi IP Cloudflare; dicoba lagi otomatis, grup diberi peringatan setelah 12 jam |
