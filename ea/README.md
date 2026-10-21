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
| `ServerUrl` | URL Render tanpa `/` di akhir |
| `DataKey` | sama dengan `EA_DATA_KEY` di environment Render |
| `SymbolSuffix` | akhiran nama simbol broker di MT4 ini, mis. `m` untuk `EURUSDm`; kosong jika tidak ada |
| `FallbackSymbols` | dipakai hanya jika daftar pair dari server tidak terbaca |
| `HistoryBars` | jumlah candle D1 yang dikirim saat pertama jalan (520 = sekitar 2 tahun) |
| `QuoteSeconds` | jeda kirim bid/ask |
| `TimeoutMs` | 30000; Render paket gratis bisa butuh 30 sampai 50 detik untuk bangun |

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

Tahap 4.
