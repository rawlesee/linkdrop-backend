import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const app = express();

const PORT = Number(process.env.PORT || 10000);
const TEMP_DIR = process.env.TEMP_DIR || path.join(os.tmpdir(), "linkdrop");
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE_MB || 500) * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS || 300000);
const ANALYZE_TIMEOUT_MS = Number(process.env.ANALYZE_TIMEOUT_MS || 60000);
const MAX_CONCURRENT_DOWNLOADS = Number(process.env.MAX_CONCURRENT_DOWNLOADS || 2);

const allowedOrigins = (process.env.CORS_ORIGIN || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const supportedHosts = [
  "youtube.com", "youtu.be",
  "tiktok.com",
  "instagram.com",
  "facebook.com", "fb.watch",
  "x.com", "twitter.com",
  "reddit.com", "redd.it"
];

await fsp.mkdir(TEMP_DIR, { recursive: true });

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error("CORS origin not allowed"));
  },
  exposedHeaders: ["Content-Disposition", "Content-Type", "Content-Length"]
}));
app.use(express.json({ limit: "32kb" }));

const limiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false
});
app.use("/api/", limiter);

const analyzeSchema = z.object({
  url: z.string().url().max(2048)
});

const downloadSchema = z.object({
  url: z.string().url().max(2048),
  formatId: z.enum(["best", "audio"])
});

function isSupportedUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol)) return false;
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return supportedHosts.some(d => host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
}

function safeFilename(name: string, ext: string): string {
  const cleaned = name
    .normalize("NFKC")
    .replace(/[<>:"/\\\\|?*\\x00-\\x1F]/g, "_")
    .replace(/\\s+/g, " ")
    .trim()
    .slice(0, 120) || "LinkDrop";
  return `${cleaned}.${ext}`;
}

function runYtdlp(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", args, { shell: false });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(new Error("Downloader timeout"));
      }
    }, timeoutMs);

    proc.stdout.on("data", c => { stdout += c.toString(); });
    proc.stderr.on("data", c => { stderr += c.toString(); });

    proc.on("error", err => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    proc.on("close", code => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ code: code ?? -1, stdout, stderr });
      }
    });
  });
}

let activeDownloads = 0;

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "LinkDrop Downloader API",
    time: new Date().toISOString()
  });
});

app.get("/", (_req, res) => {
  res.json({ service: "LinkDrop Downloader API", health: "/api/health" });
});

app.post("/api/analyze", async (req: Request, res: Response) => {
  const parsed = analyzeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: "URL tidak valid." });

  const url = parsed.data.url;
  if (!isSupportedUrl(url)) {
    return res.status(400).json({ success: false, message: "Platform belum didukung." });
  }

  try {
    const result = await runYtdlp([
      "--dump-single-json",
      "--skip-download",
      "--no-warnings",
      "--no-playlist",
      "--no-check-certificates",
      url
    ], ANALYZE_TIMEOUT_MS);

    if (result.code !== 0) {
      return res.status(422).json({
        success: false,
        message: "Media tidak tersedia, bersifat privat, atau tidak dapat diproses."
      });
    }

    const meta = JSON.parse(result.stdout);

    const formats = [
      { id: "best", label: "Video terbaik (MP4)", extension: "mp4", quality: "best", type: "video" },
      { id: "audio", label: "Audio MP3", extension: "mp3", quality: "best", type: "audio" }
    ];

    res.json({
      success: true,
      platform: meta.extractor_key || meta.extractor || "unknown",
      title: meta.title || "Media LinkDrop",
      thumbnail: meta.thumbnail || "",
      uploader: meta.uploader || meta.channel || "Publik",
      duration: meta.duration || 0,
      formats
    });
  } catch {
    res.status(504).json({ success: false, message: "Waktu pemrosesan habis. Coba lagi." });
  }
});

app.post("/api/download", async (req: Request, res: Response) => {
  const parsed = downloadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: "Parameter download tidak valid." });

  if (!isSupportedUrl(parsed.data.url)) {
    return res.status(400).json({ success: false, message: "Platform belum didukung." });
  }

  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    return res.status(429).json({ success: false, message: "Server sedang penuh. Coba lagi sebentar." });
  }

  activeDownloads++;
  const jobId = randomUUID();
  const ext = parsed.data.formatId === "audio" ? "mp3" : "mp4";
  const template = path.join(TEMP_DIR, `${jobId}.%(ext)s`);

  try {
    const args = [
      "--no-playlist",
      "--no-warnings",
      "--no-check-certificates",
      "--max-filesize", `${Math.floor(MAX_FILE_SIZE / (1024 * 1024))}M`,
      "-o", template
    ];

    if (parsed.data.formatId === "audio") {
      args.push("-x", "--audio-format", "mp3", "-f", "bestaudio/best");
    } else {
      args.push("-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best");
      args.push("--merge-output-format", "mp4");
    }

    args.push(parsed.data.url);

    const result = await runYtdlp(args, DOWNLOAD_TIMEOUT_MS);
    if (result.code !== 0) {
      return res.status(422).json({ success: false, message: "Gagal memproses file media." });
    }

    const candidates = await fsp.readdir(TEMP_DIR);
    const output = candidates
      .filter(name => name.startsWith(jobId + "."))
      .map(name => path.join(TEMP_DIR, name))
      .find(file => /\.(mp4|mp3|webm|m4a|mkv)$/i.test(file));

    if (!output) {
      return res.status(500).json({ success: false, message: "File hasil download tidak ditemukan." });
    }

    const stat = await fsp.stat(output);
    if (stat.size > MAX_FILE_SIZE) {
      await fsp.rm(output, { force: true });
      return res.status(413).json({ success: false, message: "File terlalu besar." });
    }

    const mime = ext === "mp3" ? "audio/mpeg" : "video/mp4";
    const filename = safeFilename("LinkDrop_" + new Date().toISOString().replace(/[:.]/g, "-"), ext);

    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Length", stat.size.toString());
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");

    const stream = fs.createReadStream(output);
    stream.on("error", () => {
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    stream.on("close", async () => {
      await fsp.rm(output, { force: true }).catch(() => {});
    });
    res.on("close", async () => {
      await fsp.rm(output, { force: true }).catch(() => {});
    });

    stream.pipe(res);
  } catch {
    res.status(504).json({ success: false, message: "Download timeout atau downloader gagal." });
  } finally {
    activeDownloads--;
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ success: false, message: "Terjadi kesalahan server." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`LinkDrop API listening on 0.0.0.0:${PORT}`);
});
