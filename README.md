# LinkDrop Backend

Backend Express + yt-dlp untuk LinkDrop.

## Deploy paling gampang: Render + Docker

1. Upload folder ini ke repository GitHub.
2. Di Render pilih **New → Web Service**.
3. Connect repository tersebut.
4. Pilih runtime **Docker**.
5. Deploy.
6. Setelah selesai, buka:
   `https://NAMA-SERVICE.onrender.com/api/health`
7. Jika muncul JSON dengan `"status":"ok"`, backend online.
8. Masukkan URL tersebut (tanpa `/api/health`) ke LinkDrop:
   `https://NAMA-SERVICE.onrender.com`

Render harus menerima port dari environment variable `PORT`; server di project ini juga bind ke `0.0.0.0`.

## Environment variables

Opsional:

- `CORS_ORIGIN=*`
- `MAX_FILE_SIZE_MB=500`
- `DOWNLOAD_TIMEOUT_MS=300000`
- `ANALYZE_TIMEOUT_MS=60000`
- `MAX_CONCURRENT_DOWNLOADS=2`

Untuk production, lebih aman ubah `CORS_ORIGIN` menjadi URL frontend LinkDrop, misalnya:
`https://nama-app.example`

## API

GET `/api/health`

POST `/api/analyze`

Body:
```json
{"url":"https://..."}
```

POST `/api/download`

Body:
```json
{"url":"https://...","formatId":"best"}
```

atau:
```json
{"url":"https://...","formatId":"audio"}
```

Endpoint download mengembalikan file aktual dengan `Content-Disposition: attachment`.

## Catatan

- Downloader berjalan di server, bukan browser.
- yt-dlp dan ffmpeg dipasang di Docker image.
- File temporary dihapus setelah response selesai.
- Hanya URL dari domain yang didukung yang diproses.
- Gunakan hanya untuk media publik yang Anda berhak unduh.
- Jangan gunakan untuk bypass login, private content, DRM, atau access control.
