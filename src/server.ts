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
   HEALTH
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
   ========================================================= */

app.get("/api/debug", (_req, res) => {
  const results: Record<string, unknown> = {};

  const checks: Array<[string, string[]]> = [
    ["yt-dlp", ["--version"]],
    ["ffmpeg", ["-version"]],
    ["python3", ["--version"]]
  ];

  let remaining = checks.length;
  let responseSent = false;

  function finishIfReady() {
    if (remaining === 0 && !responseSent) {
      responseSent = true;

      res.json({
        status: "debug",
        results
      });
    }
  }

  for (const [command, args] of checks) {
    const p = spawn(command, args, {
      shell: false
    });

    let stdout = "";
    let stderr = "";

    p.stdout.on("data", data => {
      stdout += data.toString();
    });

    p.stderr.on("data", data => {
      stderr += data.toString();
    });

    p.on("error", error => {
      results[command] = {
        installed: false,
        error: error.message
      };

      remaining--;

      finishIfReady();
    });

    p.on("close", code => {
      if (results[command]) {
        return;
      }

      results[command] = {
        installed: code === 0,
        exitCode: code,
        stdout: stdout.slice(0, 1000),
        stderr: stderr.slice(0, 1000)
      };

      remaining--;

      finishIfReady();
    });
  }
});


/* =========================================================
   ANALYZE
   ========================================================= */

app.post("/api/analyze", (req, res) => {
  const url = req.body?.url;

  if (!validPublicUrl(url)) {
    return res.status(400).json({
      success: false,
      message: "URL publik yang didukung diperlukan."
    });
  }

  console.log("[ANALYZE] Starting yt-dlp");
  console.log("[ANALYZE] URL:", url);

  const p = spawn("yt-dlp", [
    "--dump-single-json",
    "--skip-download",
    "--no-warnings",
    "--no-playlist",
    url
  ], {
    shell: false
  });

  let out = "";
  let err = "";
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;

    console.error(
      "[ANALYZE] TIMEOUT after 25 seconds"
    );

    p.kill("SIGKILL");
  }, 25_000);

  p.stdout.on("data", data => {
    out += data.toString();

    if (out.length > 2_000_000) {
      out = out.slice(-2_000_000);
    }
  });

  p.stderr.on("data", data => {
    err += data.toString();

    if (err.length > 8_000) {
      err = err.slice(-8_000);
    }
  });

  p.on("error", error => {
    clearTimeout(timer);

    console.error(
      "[ANALYZE] SPAWN ERROR:",
      error.message
    );

    if (!res.headersSent) {
      res.status(502).json({
        success: false,
        message: "yt-dlp tidak dapat dijalankan di server."
      });
    }
  });

  p.on("close", code => {
    clearTimeout(timer);

    console.log(
      "[ANALYZE] yt-dlp exit code:",
      code
    );

    if (err.trim()) {
      console.error(
        "[ANALYZE] yt-dlp stderr:"
      );

      console.error(err);
    }

    if (timedOut) {
      return res.status(504).json({
        success: false,
        message: "Proses analisis terlalu lama."
      });
    }

    if (code !== 0) {
      return res.status(502).json({
        success: false,
        message:
          "Media tidak tersedia atau platform menolak permintaan."
      });
    }

    try {
      const meta = JSON.parse(out);

      console.log(
        "[ANALYZE] Success:",
        meta.title
      );

      return res.json({
        success: true,

        title:
          meta.title ||
          "Media LinkDrop",

        thumbnail:
          meta.thumbnail ||
          "",

        uploader:
          meta.uploader ||
          "Publik",

        duration:
          meta.duration ||
          0,

        formats: [
          {
            id: "best",
            label: "MP4 (Best Available)",
            extension: "mp4",
            quality: "best",
            type: "video"
          },
          {
            id: "audio",
            label: "MP3 (Audio)",
            extension: "mp3",
            quality: "best",
            type: "audio"
          }
        ]
      });

    } catch (error) {
      console.error(
        "[ANALYZE] JSON parse error:",
        error
      );

      console.error(
        "[ANALYZE] Raw output:",
        out.slice(-4000)
      );

      return res.status(502).json({
        success: false,
        message: "Gagal membaca metadata media."
      });
    }
  });
});


/* =========================================================
   DOWNLOAD
   ========================================================= */

app.post("/api/download", (req, res) => {
  const {
    url,
    formatId
  } = req.body ?? {};

  if (!validPublicUrl(url)) {
    return res.status(400).json({
      success: false,
      message: "URL publik yang didukung diperlukan."
    });
  }

  const audio = formatId === "audio";

  const ext = audio
    ? "mp3"
    : "mp4";

  const format = audio
    ? "bestaudio/best"
    : "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best";

  console.log(
    "[DOWNLOAD] Starting yt-dlp"
  );

  console.log(
    "[DOWNLOAD] URL:",
    url
  );

  console.log(
    "[DOWNLOAD] Format:",
    format
  );

  const p = spawn("yt-dlp", [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--restrict-filenames",

    "-f",
    format,

    ...(audio
      ? [
          "--extract-audio",
          "--audio-format",
          "mp3"
        ]
      : [
          "--merge-output-format",
          "mp4"
        ]),

    "-o",
    "-",

    url
  ], {
    shell: false
  });

  res.statusCode = 200;

  res.setHeader(
    "Content-Type",
    audio
      ? "audio/mpeg"
      : "video/mp4"
  );

  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${safeFilename(
      "LinkDrop_Media",
      ext
    )}"`
  );

  let started = false;
  let stderr = "";
  let timedOut = false;

  p.stdout.on("data", chunk => {
    started = true;
    res.write(chunk);
  });

  p.stderr.on("data", data => {
    stderr += data.toString();

    if (stderr.length > 8_000) {
      stderr = stderr.slice(-8_000);
    }
  });

  p.on("error", error => {
    console.error(
      "[DOWNLOAD] SPAWN ERROR:",
      error.message
    );

    if (!started && !res.headersSent) {
      res.status(502).json({
        success: false,
        message:
          "yt-dlp tidak dapat dijalankan di server."
      });
    }
  });

  const timer = setTimeout(() => {
    timedOut = true;

    console.error(
      "[DOWNLOAD] TIMEOUT after 240 seconds"
    );

    p.kill("SIGKILL");
  }, 240_000);

  p.on("close", code => {
    clearTimeout(timer);

    console.log(
      "[DOWNLOAD] yt-dlp exit code:",
      code
    );

    if (stderr.trim()) {
      console.error(
        "[DOWNLOAD] yt-dlp stderr:"
      );

      console.error(stderr);
    }

    if (timedOut) {
      if (!res.writableEnded) {
        res.end();
      }

      return;
    }

    if (!started && code !== 0) {
      if (!res.headersSent) {
        res.status(502).json({
          success: false,
          message:
            "Gagal memproses file media."
        });
      } else if (!res.writableEnded) {
        res.end();
      }

      return;
    }

    if (!res.writableEnded) {
      res.end();
    }
  });

  req.on("close", () => {
    if (!res.writableEnded) {
      p.kill("SIGTERM");
    }
  });
});


/* =========================================================
   START SERVER
   ========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `LinkDrop API listening on ${PORT}`
    );
  }
);
