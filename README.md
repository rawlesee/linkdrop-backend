# LinkDrop Vercel Backend

Backend Docker untuk LinkDrop menggunakan Node.js, yt-dlp, dan FFmpeg.

Endpoints:
- GET /api/health
- POST /api/analyze
- POST /api/download

Deploy memakai Vercel Container dengan Dockerfile.vercel.

Catatan:
- Hanya URL media publik.
- Tidak membypass login, private content, DRM, atau paywall.
- Download hanya konten yang pengguna punya hak untuk simpan.
- Container Vercel bersifat stateless; file tidak disimpan permanen.
