import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.set("trust proxy", 1);

app.use(cors({
  origin: "*",
  exposedHeaders: [
    "Content-Disposition",
    "Content-Type",
    "Content-Length"
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
   RUN COMMAND
   ========================================================= */

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return new Promise(resolve => {

    const p = spawn(command, args, {
      shell: false
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;

      console.error(
        `[COMMAND] ${command} TIMEOUT`
      );

      p.kill("SIGKILL");

    }, timeoutMs);

    p.stdout.on("data", data => {
      stdout += data.toString();

      if (stdout.length > 2_000_000) {
        stdout = stdout.slice(-2_000_000);
      }
    });

    p.stderr.on("data", data => {
      stderr += data.toString();

      if (stderr.length > 12_000) {
        stderr = stderr.slice(-12_000);
      }
    });

    p.on("error", error => {
      clearTimeout(timer);

      stderr += `\n${error.message}`;

      resolve({
        code: null,
        stdout,
        stderr,
        timedOut
      });
    });

    p.on("close", code => {
      clearTimeout(timer);

      resolve({
        code,
        stdout,
        stderr,
        timedOut
      });
    });
  });
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

app.get("/api/debug", async (_req, res) => {

  const results: Record<string, unknown> = {};

  const checks: Array<[string, string[]]> = [
    ["yt-dlp", ["--version"]],
    ["ffmpeg", ["-version"]],
    ["python3", ["--version"]]
  ];

  for (const [command, args] of checks) {

    const result = await runCommand(
      command,
      args,
      10_000
    );

    results[command] = {
      installed:
        result.code === 0,

      exitCode:
        result.code,

      stdout:
        result.stdout.slice(0, 1000),

      stderr:
        result.stderr.slice(0, 1000)
    };
  }

  res.json({
    status: "debug",
    results
  });
});


/* =========================================================
   ANALYZE
   ========================================================= */

app.post("/api/analyze", async (req, res) => {

  const url = req.body?.url;

  if (!validPublicUrl(url)) {
    return res.status(400).json({
      success: false,
      message:
        "URL publik yang didukung diperlukan."
    });
  }

  console.log(
    "[ANALYZE] Starting yt-dlp"
  );

  console.log(
    "[ANALYZE] URL:",
    url
  );

  const result = await runCommand(
    "yt-dlp",
    [
      "--dump-single-json",
      "--skip-download",
      "--no-warnings",
      "--no-playlist",
      url
    ],
    25_000
  );

  console.log(
    "[ANALYZE] yt-dlp exit code:",
    result.code
  );

  if (result.stderr.trim()) {
    console.error(
      "[ANALYZE] yt-dlp stderr:"
    );

    console.error(
      result.stderr
    );
  }

  if (result.timedOut) {
    return res.status(504).json({
      success: false,
      message:
        "Proses analisis terlalu lama."
    });
  }

  if (result.code !== 0) {

    return res.status(502).json({
      success: false,
      message:
        "Media tidak tersedia atau platform menolak permintaan."
    });
  }

  try {

    const meta = JSON.parse(
      result.stdout
    );

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
      result.stdout.slice(-4000)
    );

    return res.status(502).json({
      success: false,
      message:
        "Gagal membaca metadata media."
    });
  }
});


/* =========================================================
   DOWNLOAD
   ========================================================= */

app.post("/api/download", async (req, res) => {

  const {
    url,
    formatId
  } = req.body ?? {};

  if (!validPublicUrl(url)) {

    return res.status(400).json({
      success: false,
      message:
        "URL publik yang didukung diperlukan."
    });
  }

  const audio =
    formatId === "audio";

  const ext =
    audio
      ? "mp3"
      : "mp4";

  console.log(
    "[DOWNLOAD] Starting yt-dlp"
  );

  console.log(
    "[DOWNLOAD] URL:",
    url
  );

  console.log(
    "[DOWNLOAD] Type:",
    audio
      ? "MP3"
      : "MP4"
  );


  /* =======================================================
     TEMP DIRECTORY
     ======================================================= */

  const tempDir =
    await fs.mkdtemp(
      path.join(
        os.tmpdir(),
        "linkdrop-"
      )
    );

  const outputTemplate =
    path.join(
      tempDir,
      "media.%(ext)s"
    );


  /* =======================================================
     YT-DLP ARGUMENTS
     ======================================================= */

  const args = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--restrict-filenames"
  ];


  if (audio) {

    args.push(
      "-f",
      "bestaudio/best",

      "--extract-audio",

      "--audio-format",
      "mp3",

      "--audio-quality",
      "0"
    );

  } else {

    args.push(
      "-f",
      "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",

      "--merge-output-format",
      "mp4",

      // Make the MP4 start playing immediately
      // on mobile/browser players.
      "--postprocessor-args",
      "Merger+ffmpeg:-movflags +faststart"
    );
  }


  args.push(
    "-o",
    outputTemplate,
    url
  );


  console.log(
    "[DOWNLOAD] Running yt-dlp..."
  );


  /* =======================================================
     RUN YT-DLP
     ======================================================= */

  const result =
    await runCommand(
      "yt-dlp",
      args,
      240_000
    );


  console.log(
    "[DOWNLOAD] yt-dlp exit code:",
    result.code
  );


  if (result.stderr.trim()) {

    console.error(
      "[DOWNLOAD] yt-dlp stderr:"
    );

    console.error(
      result.stderr
    );
  }


  if (result.timedOut) {

    await fs.rm(
      tempDir,
      {
        recursive: true,
        force: true
      }
    );

    return res.status(504).json({
      success: false,
      message:
        "Proses download terlalu lama."
    });
  }


  if (result.code !== 0) {

    await fs.rm(
      tempDir,
      {
        recursive: true,
        force: true
      }
    );

    return res.status(502).json({
      success: false,
      message:
        "Gagal memproses file media."
    });
  }


  /* =======================================================
     FIND OUTPUT FILE
     ======================================================= */

  let files: string[] = [];

  try {

    files =
      await fs.readdir(
        tempDir
      );

  } catch {

    await fs.rm(
      tempDir,
      {
        recursive: true,
        force: true
      }
    );

    return res.status(502).json({
      success: false,
      message:
        "File hasil download tidak ditemukan."
    });
  }


  console.log(
    "[DOWNLOAD] Output files:",
    files
  );


  let outputFile: string | null =
    null;


  if (audio) {

    const mp3 =
      files.find(
        file =>
          file.toLowerCase().endsWith(".mp3")
      );

    if (mp3) {
      outputFile =
        path.join(
          tempDir,
          mp3
        );
    }

  } else {

    const mp4 =
      files.find(
        file =>
          file.toLowerCase().endsWith(".mp4")
      );

    if (mp4) {
      outputFile =
        path.join(
          tempDir,
          mp4
        );
    }
  }


  if (!outputFile) {

    console.error(
      "[DOWNLOAD] No final output file found"
    );

    await fs.rm(
      tempDir,
      {
        recursive: true,
        force: true
      }
    );

    return res.status(502).json({
      success: false,
      message:
        "File hasil download tidak ditemukan."
    });
  }


  /* =======================================================
     CHECK FILE SIZE
     ======================================================= */

  const stat =
    await fs.stat(
      outputFile
    );


  console.log(
    "[DOWNLOAD] Final file size:",
    stat.size,
    "bytes"
  );


  if (stat.size < 1024) {

    console.error(
      "[DOWNLOAD] Output file is suspiciously small"
    );

    await fs.rm(
      tempDir,
      {
        recursive: true,
        force: true
      }
    );

    return res.status(502).json({
      success: false,
      message:
        "File media yang dihasilkan tidak valid."
    });
  }


  /* =======================================================
     SEND FILE
     ======================================================= */

  const filename =
    safeFilename(
      "LinkDrop_Media",
      ext
    );


  res.statusCode = 200;

  res.setHeader(
    "Content-Type",
    audio
      ? "audio/mpeg"
      : "video/mp4"
  );

  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`
  );

  res.setHeader(
    "Content-Length",
    String(stat.size)
  );


  console.log(
    "[DOWNLOAD] Sending file:",
    filename
  );


  /* =======================================================
     STREAM FILE TO CLIENT
     ======================================================= */

  const fileStream =
    (await import("node:fs"))
      .createReadStream(
        outputFile
      );


  fileStream.on(
    "error",
    async error => {

      console.error(
        "[DOWNLOAD] File stream error:",
        error
      );

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message:
            "Gagal mengirim file."
        });
      } else {
        res.destroy(error);
      }

      await fs.rm(
        tempDir,
        {
          recursive: true,
          force: true
        }
      );
    }
  );


  fileStream.on(
    "close",
    async () => {

      console.log(
        "[DOWNLOAD] File stream closed"
      );

      await fs.rm(
        tempDir,
        {
          recursive: true,
          force: true
        }
      );

      console.log(
        "[DOWNLOAD] Temp files cleaned"
      );
    }
  );


  fileStream.pipe(res);
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
