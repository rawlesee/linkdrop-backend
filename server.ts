import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { spawn } from "node:child_process";

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.set("trust proxy", 1);
app.use(cors({ origin: "*", exposedHeaders: ["Content-Disposition", "Content-Type"] }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "32kb" }));

app.use("/api/", rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
}));

function validPublicUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const host = u.hostname.toLowerCase();
    const allowed = [
      "youtube.com", "www.youtube.com", "youtu.be",
      "tiktok.com", "www.tiktok.com", "vm.tiktok.com", "vt.tiktok.com",
      "instagram.com", "www.instagram.com",
      "facebook.com", "www.facebook.com", "fb.watch",
      "x.com", "www.x.com", "twitter.com", "www.twitter.com",
      "reddit.com", "www.reddit.com", "redd.it"
    ];
    return allowed.some(h => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}

function safeFilename(name: string, ext: string) {
  const clean = name
    .replace(/[\\/:*?"<>|\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return `${clean || "LinkDrop_Media"}.${ext}`;
}

app.get("/", (_req, res) => {
  res.json({ name: "LinkDrop API", status: "online" });
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "linkdrop-backend", time: new Date().toISOString() });
});

app.post("/api/analyze", (req, res) => {
  const url = req.body?.url;
  if (!validPublicUrl(url)) {
    return res.status(400).json({ success: false, message: "URL publik yang didukung diperlukan." });
  }

  const p = spawn("yt-dlp", [
    "--dump-single-json",
    "--skip-download",
    "--no-warnings",
    "--no-playlist",
    url
  ], { shell: false });

  let out = "";
  let err = "";
  const timer = setTimeout(() => p.kill("SIGKILL"), 25_000);

  p.stdout.on("data", d => { out += d.toString(); });
  p.stderr.on("data", d => { err += d.toString(); });

  p.on("close", code => {
    clearTimeout(timer);
    if (code !== 0) {
      return res.status(502).json({
        success: false,
        message: "Media tidak tersedia atau platform menolak permintaan."
      });
    }

    try {
      const meta = JSON.parse(out);
      return res.json({
        success: true,
        title: meta.title || "Media LinkDrop",
        thumbnail: meta.thumbnail || "",
        uploader: meta.uploader || "Publik",
        duration: meta.duration || 0,
        formats: [
          { id: "best", label: "MP4 (Best Available)", extension: "mp4", quality: "best", type: "video" },
          { id: "audio", label: "MP3 (Audio)", extension: "mp3", quality: "best", type: "audio" }
        ]
      });
    } catch {
      return res.status(502).json({ success: false, message: "Gagal membaca metadata media." });
    }
  });
});

app.post("/api/download", (req, res) => {
  const { url, formatId } = req.body ?? {};
  if (!validPublicUrl(url)) {
    return res.status(400).json({ success: false, message: "URL publik yang didukung diperlukan." });
  }

  const audio = formatId === "audio";
  const ext = audio ? "mp3" : "mp4";
  const format = audio
    ? "bestaudio/best"
    : "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best";

  const p = spawn("yt-dlp", [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--restrict-filenames",
    "-f", format,
    ...(audio ? ["--extract-audio", "--audio-format", "mp3"] : ["--merge-output-format", "mp4"]),
    "-o", "-",
    url
  ], { shell: false });

  res.statusCode = 200;
  res.setHeader("Content-Type", audio ? "audio/mpeg" : "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="${safeFilename("LinkDrop_Media", ext)}"`);

  let started = false;
  p.stdout.on("data", chunk => {
    started = true;
    res.write(chunk);
  });

  let stderr = "";
  p.stderr.on("data", d => { stderr += d.toString().slice(-4000); });

  const timer = setTimeout(() => p.kill("SIGKILL"), 240_000);

  p.on("close", code => {
    clearTimeout(timer);
    if (!started && !res.headersSent) {
      res.statusCode = 502;
      return res.json({ success: false, message: "Gagal memproses file media." });
    }
    if (!res.writableEnded) res.end();
  });

  req.on("close", () => {
    if (!res.writableEnded) p.kill("SIGTERM");
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`LinkDrop API listening on ${PORT}`);
});
