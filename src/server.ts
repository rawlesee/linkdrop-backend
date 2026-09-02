import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { spawn } from "node:child_process";

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.set("trust proxy", 1);

app.use(cors({
  origin: "*",
  exposedHeaders: [
    "Content-Disposition",
    "Content-Type"
  ]
}));

app.use(helmet({
  contentSecurityPolicy: false
}));

app.use(express.json({
  limit: "32kb"
}));

app.use("/api/", rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
}));


/* =========================================================
   URL VALIDATION
   ========================================================= */

function validPublicUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) {
    return false;
  }

  try {
    const u = new URL(value);

    if (
      u.protocol !== "https:" &&
      u.protocol !== "http:"
    ) {
      return false;
    }

    const host = u.hostname.toLowerCase();

    const allowed = [
      "youtube.com",
      "www.youtube.com",
      "youtu.be",

      "tiktok.com",
      "www.tiktok.com",
      "vm.tiktok.com",
      "vt.tiktok.com",

      "instagram.com",
      "www.instagram.com",

      "facebook.com",
      "www.facebook.com",
      "fb.watch",

      "x.com",
      "www.x.com",
      "twitter.com",
      "www.twitter.com",

      "reddit.com",
      "www.reddit.com",
      "redd.it"
    ];

    return allowed.some(
      h => host === h || host.endsWith("." + h)
    );

  } catch {
    return false;
  }
}


/* =========================================================
   SAFE FILENAME
   ========================================================= */

function safeFilename(name: string, ext: string) {
  const clean = name
    .replace(/[\\/:*?"<>|\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);

  return `${clean || "LinkDrop_Media"}.${ext}`;
}


/* =========================================================
   ROOT
   ========================================================= */

app.get("/", (_req, res) => {
  res.json({
    name: "LinkDrop API",
    status: "online"
  });
});


/* =========================================================
   HEALTH CHECK
   ========================================================= */

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "linkdrop-backend",
    time: new Date().toISOString()
  });
});


/* =========================================================
   DEBUG
   =========================================================
   Endpoint sementara untuk mengecek apakah yt-dlp,
   FFmpeg dan Python tersedia di container Vercel.
   ========================================================= */

app.get("/api/debug", (_req, res) => {

  const results: Record<string, any> = {};

  const checks: Array<[string, string[]]> = [
    ["yt-dlp", ["--version"]],
    ["ffmpeg", ["-version"]],
    ["python3", ["--version"]]
  ];

  let remaining = checks.length;

  for (const [command, args] of checks) {

    const p = spawn(
      command,
      args,
      {
        shell: false
      }
    );

    let stdout = "";
    let stderr = "";

    p.stdout.on("data", d => {
      stdout += d.toString();
    });

    p
