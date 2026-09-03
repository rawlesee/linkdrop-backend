import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createReadStream } from "node:fs";
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
   CONSTANTS
   ========================================================= */

const MAX_IMAGE_SIZE =
  Number(process.env.MAX_IMAGE_SIZE_MB || 50) * 1024 * 1024;


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
   PLATFORM
   ========================================================= */

function getInstagramPostUrl(value: string): boolean {
  try {
    const u = new URL(value);

    return (
      /(^|\/)p\/[^/]+/i.test(u.pathname)
    );

  } catch {
    return false;
  }
}


/* =========================================================
   SAFE FILENAME
   ========================================================= */

function safeFilename(
  name: string,
  ext: string
): string {

  const clean = name
    .replace(/[\\/:*?"<>|\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);

  const safeExt =
    ext
      .replace(/[^a-zA-Z0-9]/g, "")
      .toLowerCase() ||
    "bin";

  return `${clean || "LinkDrop_Media"}.${safeExt}`;
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

    console.log(
      `[COMMAND] ${command} ${args.join(" ")}`
    );

    const p = spawn(command, args, {
      shell: false
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let finished = false;

    const finish = (
      result: {
        code: number | null;
        stdout: string;
        stderr: string;
        timedOut: boolean;
      }
    ) => {

      if (finished) {
        return;
      }

      finished = true;

      clearTimeout(timer);

      resolve(result);
    };

    const timer = setTimeout(() => {

      if (finished) {
        return;
      }

      timedOut = true;

      console.error(
        `[COMMAND] ${command} TIMEOUT`
      );

      try {
        p.kill("SIGKILL");
      } catch {
        // ignore
      }

      setTimeout(() => {

        finish({
          code: null,
          stdout,
          stderr,
          timedOut: true
        });

      }, 250);

    }, timeoutMs);


    p.stdout.on("data", data => {

      stdout += data.toString();

      if (stdout.length > 2_000_000) {
        stdout =
          stdout.slice(-2_000_000);
      }
    });


    p.stderr.on("data", data => {

      stderr += data.toString();

      if (stderr.length > 12_000) {
        stderr =
          stderr.slice(-12_000);
      }
    });


    p.on("error", error => {

      console.error(
        `[COMMAND] ${command} ERROR:`,
        error.message
      );

      stderr += `\n${error.message}`;

      finish({
        code: null,
        stdout,
        stderr,
        timedOut
      });

    });


    p.on("close", code => {

      console.log(
        `[COMMAND] ${command} EXIT: ${code}`
      );

      finish({
        code,
        stdout,
        stderr,
        timedOut
      });

    });

  });
}


/* =========================================================
   GALLERY-DL RESULT TYPES
   ========================================================= */

type GalleryMedia = {
  url: string;
  metadata: Record<string, unknown>;
};

type InstagramExtraction = {
  isSinglePhoto: boolean;
  isVideoPost: boolean;
  isCarousel: boolean;
  title?: string;
  photoUrl?: string;
  ext?: string;
  error?: string;
};


/* =========================================================
   GALLERY-DL HELPERS
   ========================================================= */

function isImageExtension(
  ext: string
): boolean {

  return [
    "jpg",
    "jpeg",
    "png",
    "webp",
    "gif",
    "avif"
  ].includes(
    ext.toLowerCase()
  );
}


function getExtensionFromUrl(
  value: string
): string {

  try {

    const u = new URL(value);

    const pathname =
      u.pathname.toLowerCase();

    const match =
      pathname.match(
        /\.([a-z0-9]+)$/
      );

    if (match) {
      return match[1];
    }

  } catch {
    // ignore
  }

  return "jpg";
}


function getMetadataString(
  metadata: Record<string, unknown>,
  key: string
): string {

  const value =
    metadata[key];

  return typeof value === "string"
    ? value
    : "";
}


/* =========================================================
   EXTRACT INSTAGRAM SINGLE PHOTO
   ========================================================= */

async function extractInstagramSinglePhoto(
  targetUrl: string
): Promise<InstagramExtraction> {

  try {

    const parsed =
      new URL(targetUrl);

    if (
      !parsed.hostname
        .toLowerCase()
        .includes("instagram.com")
    ) {
      return {
        isSinglePhoto: false,
        isVideoPost: false,
        isCarousel: false
      };
    }


    if (
      !parsed.pathname
        .toLowerCase()
        .includes("/p/")
    ) {
      return {
        isSinglePhoto: false,
        isVideoPost: false,
        isCarousel: false
      };
    }


    console.log(
      "[ANALYZE:INSTAGRAM] Running gallery-dl for Instagram /p/"
    );


    /*
     * gallery-dl:
     *
     * Message.Directory = 2
     * Message.Url       = 3
     *
     * We use -j to dump these messages as JSON.
     */
    const result =
      await runCommand(
        "gallery-dl",
        [
          "-j",
          "--no-download",
          targetUrl
        ],
        25_000
      );


    if (result.timedOut) {

      return {
        isSinglePhoto: false,
        isVideoPost: false,
        isCarousel: false,
        error: "gallery-dl timeout."
      };
    }


    const stdout =
      result.stdout.trim();


    if (!stdout) {

      console.warn(
        "[gallery-dl] stdout kosong."
      );

      return {
        isSinglePhoto: false,
        isVideoPost: false,
        isCarousel: false,
        error:
          result.stderr.trim() ||
          "Output gallery-dl kosong."
      };
    }


    const lines =
      stdout
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean);


    const messages: unknown[] = [];


    for (const line of lines) {

      try {

        messages.push(
          JSON.parse(line)
        );

      } catch {

        console.warn(
          "[gallery-dl] Mengabaikan JSON line yang tidak valid."
        );

      }
    }


    if (messages.length === 0) {

      return {
        isSinglePhoto: false,
        isVideoPost: false,
        isCarousel: false,
        error:
          "Tidak ada JSON valid dari gallery-dl."
      };
    }


    const directoryMetadata:
      Record<string, unknown> = {};


    const media: GalleryMedia[] = [];


    /*
     * Parse gallery-dl message protocol.
     */
    for (const message of messages) {

      if (!Array.isArray(message)) {
        continue;
      }


      const type =
        message[0];


      /*
       * Message.Directory = 2
       */
      if (
        type === 2 &&
        message.length >= 3 &&
        typeof message[2] === "object" &&
        message[2] !== null
      ) {

        Object.assign(
          directoryMetadata,
          message[2] as Record<string, unknown>
        );

        continue;
      }


      /*
       * Message.Url = 3
       *
       * [3, "https://media-url", metadata]
       */
      if (
        type === 3 &&
        typeof message[1] === "string"
      ) {

        const metadata =
          (
            typeof message[2] === "object" &&
            message[2] !== null
          )
            ? message[2] as Record<string, unknown>
            : {};

        media.push({
          url: message[1],
          metadata
        });

      }

    }


    console.log(
      `[gallery-dl] Media URL count: ${media.length}`
    );


    if (media.length === 0) {

      return {
        isSinglePhoto: false,
        isVideoPost: false,
        isCarousel: false,
        error:
          result.stderr.trim() ||
          "gallery-dl tidak menemukan media."
      };
    }


    /*
     * Determine metadata.
     */
    const firstMetadata =
      media[0]?.metadata || {};


    const typename =
      getMetadataString(
        firstMetadata,
        "typename"
      ) ||
      getMetadataString(
        directoryMetadata,
        "typename"
      );


    const description =
      getMetadataString(
        firstMetadata,
        "description"
      ) ||
      getMetadataString(
        directoryMetadata,
        "description"
      ) ||
      getMetadataString(
        firstMetadata,
        "caption"
      ) ||
      getMetadataString(
        directoryMetadata,
        "caption"
      ) ||
      "Instagram Photo";


    /*
     * Check video.
     */
    const containsVideo =
      media.some(item => {

        const ext =
          getExtensionFromUrl(
            item.url
          );

        const itemType =
          getMetadataString(
            item.metadata,
            "typename"
          );

        return (
          itemType === "GraphVideo" ||
          ext === "mp4" ||
          ext === "mov" ||
          ext === "webm"
        );

      });


    if (
      typename === "GraphVideo" ||
      containsVideo
    ) {

      console.log(
        "[gallery-dl] Instagram /p/ terdeteksi sebagai VIDEO."
      );

      return {
        isSinglePhoto: false,
        isVideoPost: true,
        isCarousel: false
      };
    }


    /*
     * More than one actual media URL = carousel.
     *
     * IMPORTANT:
     * We do NOT use number of JSON lines here because
     * Directory + Url messages can both exist for a
     * single photo.
     */
    if (
      media.length > 1 ||
      typename === "GraphSidecar"
    ) {

      console.log(
        "[gallery-dl] Instagram post terdeteksi sebagai CAROUSEL."
      );

      return {
        isSinglePhoto: false,
        isVideoPost: false,
        isCarousel: true,
        error:
          "Postingan carousel belum diaktifkan."
      };
    }


    /*
     * Single media.
     */
    const photo =
      media[0];


    if (
      !photo.url.startsWith("https://") &&
      !photo.url.startsWith("http://")
    ) {

      return {
        isSinglePhoto: false,
        isVideoPost: false,
        isCarousel: false,
        error:
          "URL media Instagram tidak valid."
      };
    }


    const ext =
      getExtensionFromUrl(
        photo.url
      );


    if (!isImageExtension(ext)) {

      return {
        isSinglePhoto: false,
        isVideoPost: false,
        isCarousel: false,
        error:
          `Media bukan format gambar: ${ext}`
      };
    }


    console.log(
      "[gallery-dl] Single Instagram photo berhasil ditemukan."
    );


    return {
      isSinglePhoto: true,
      isVideoPost: false,
      isCarousel: false,
      title:
        description
          .substring(0, 80)
          .trim() ||
        "Instagram Photo",
      photoUrl:
        photo.url,
      ext
    };


  } catch (error: unknown) {

    const message =
      error instanceof Error
        ? error.message
        : String(error);


    console.error(
      "[gallery-dl Error]:",
      message
    );


    return {
      isSinglePhoto: false,
      isVideoPost: false,
      isCarousel: false,
      error: message
    };
  }
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
   DEBUG ENVIRONMENT
   ========================================================= */

app.get("/api/debug", async (_req, res) => {

  const results:
    Record<string, unknown> = {};


  const checks:
    Array<[string, string[]]> = [

      ["gallery-dl", ["--version"]],

      ["yt-dlp", ["--version"]],

      ["ffmpeg", ["-version"]],

      ["python3", ["--version"]]

    ];


  for (
    const [command, args]
    of checks
  ) {

    const result =
      await runCommand(
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
        result.stdout
          .slice(0, 1000),

      stderr:
        result.stderr
          .slice(0, 1000)

    };

  }


  res.json({
    status: "debug",
    results
  });

});


/* =========================================================
   DEBUG GALLERY-DL
   ========================================================= */

app.get(
  "/api/debug-gallery",
  async (req, res) => {

    const targetUrl =
      req.query.url;


    if (
      !validPublicUrl(targetUrl)
    ) {

      return res.status(400).json({

        success: false,

        message:
          "URL publik yang didukung diperlukan."

      });

    }


    try {

      const parsed =
        new URL(targetUrl);


      if (
        !parsed.hostname
          .toLowerCase()
          .includes("instagram.com")
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Endpoint debug ini khusus Instagram."

        });

      }


      if (
        !getInstagramPostUrl(targetUrl)
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Gunakan URL Instagram /p/."

        });

      }


      const result =
        await runCommand(
          "gallery-dl",
          [
            "-j",
            "--no-download",
            targetUrl
          ],
          25_000
        );


      const stdout =
        result.stdout.length > 10_240
          ? result.stdout.substring(
              0,
              10_240
            ) +
            "\n... [TRUNCATED]"
          : result.stdout;


      const stderr =
        result.stderr.length > 5_120
          ? result.stderr.substring(
              0,
              5_120
            ) +
            "\n... [TRUNCATED]"
          : result.stderr;


      return res.json({

        success:
          result.code === 0 &&
          !result.timedOut,

        command:
          "gallery-dl -j --no-download <URL>",

        exitCode:
          result.code,

        timedOut:
          result.timedOut,

        stdout,

        stderr

      });


    } catch (error: unknown) {

      const message =
        error instanceof Error
          ? error.message
          : String(error);


      return res.status(500).json({

        success: false,

        message,

        stdout: "",

        stderr: message

      });

    }

  }
);


/* =========================================================
   ANALYZE
   ========================================================= */

app.post(
  "/api/analyze",
  async (req, res) => {

    const url =
      req.body?.url;


    if (
      !validPublicUrl(url)
    ) {

      return res.status(400).json({

        success: false,

        message:
          "URL publik yang didukung diperlukan."

      });

    }


    /*
     * =====================================================
     * INSTAGRAM /p/
     *
     * gallery-dl FIRST.
     * yt-dlp MUST NOT run first.
     * =====================================================
     */

    if (
      getInstagramPostUrl(url)
    ) {

      console.log(
        "[ANALYZE] Instagram /p/ detected."
      );

      console.log(
        "[ANALYZE] Running gallery-dl FIRST."
      );


      const photoResult =
        await extractInstagramSinglePhoto(
          url
        );


      if (
        photoResult.isSinglePhoto &&
        photoResult.photoUrl
      ) {

        console.log(
          "[ANALYZE] Instagram single photo SUCCESS."
        );


        return res.json({

          success: true,

          platform: "instagram",

          type: "image",

          title:
            photoResult.title ||
            "Instagram Photo",

          thumbnail:
            photoResult.photoUrl,

          uploader:
            "Instagram User",

          url,

          items: [

            {

              index: 0,

              type: "image",

              url:
                photoResult.photoUrl,

              ext:
                photoResult.ext ||
                "jpg"

            }

          ]

        });

      }


      if (
        photoResult.isCarousel
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Instagram Carousel belum didukung. Saat ini LinkDrop hanya memproses foto tunggal."

        });

      }


      if (
        !photoResult.isVideoPost
      ) {

        console.warn(
          "[ANALYZE] gallery-dl gagal mengidentifikasi foto tunggal."
        );

        console.warn(
          "[ANALYZE] Error:",
          photoResult.error || "unknown"
        );

      } else {

        console.log(
          "[ANALYZE] Instagram /p/ dikonfirmasi sebagai video."
        );

      }

    }


    /*
     * =====================================================
     * VIDEO PIPELINE
     *
     * TikTok / Instagram Reel / X / YouTube / etc.
     * =====================================================
     */

    console.log(
      "[ANALYZE] Starting yt-dlp"
    );

    console.log(
      "[ANALYZE] URL:",
      url
    );


    const result =
      await runCommand(
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


    if (
      result.stderr.trim()
    ) {

      console.error(
        "[ANALYZE] yt-dlp stderr:"
      );

      console.error(
        result.stderr
      );

    }


    if (
      result.timedOut
    ) {

      return res.status(504).json({

        success: false,

        message:
          "Proses analisis terlalu lama."

      });

    }


    if (
      result.code !== 0
    ) {

      return res.status(502).json({

        success: false,

        message:
          "Media tidak tersedia atau platform menolak permintaan."

      });

    }


    try {

      const meta =
        JSON.parse(
          result.stdout
        );


      console.log(
        "[ANALYZE] Success:",
        meta.title
      );


      return res.json({

        success: true,

        platform:
          meta.extractor_key ||
          meta.extractor ||
          "unknown",

        type:
          "video",

        title:
          meta.title ||
          "Media LinkDrop",

        thumbnail:
          meta.thumbnail ||
          "",

        uploader:
          meta.uploader ||
          meta.channel ||
          "Publik",

        duration:
          meta.duration ||
          0,

        url,

        formats: [

          {

            id: "best",

            label:
              "MP4 (Best Available)",

            extension:
              "mp4",

            quality:
              "best",

            type:
              "video"

          },

          {

            id: "audio",

            label:
              "MP3 (Audio)",

            extension:
              "mp3",

            quality:
              "best",

            type:
              "audio"

          }

        ]

      });


    } catch (error: unknown) {

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

  }
);


/* =========================================================
   DOWNLOAD VIDEO / AUDIO
   ========================================================= */

app.post(
  "/api/download",
  async (req, res) => {

    const {
      url,
      formatId
    } = req.body ?? {};


    if (
      !validPublicUrl(url)
    ) {

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

        "--postprocessor-args",
        "Merger+ffmpeg:-movflags +faststart"

      );

    }


    args.push(
      "-o",
      outputTemplate,
      url
    );


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


    if (
      result.stderr.trim()
    ) {

      console.error(
        "[DOWNLOAD] yt-dlp stderr:"
      );

      console.error(
        result.stderr
      );

    }


    if (
      result.timedOut ||
      result.code !== 0
    ) {

      await fs.rm(
        tempDir,
        {
          recursive: true,
          force: true
        }
      );


      return res.status(
        result.timedOut
          ? 504
          : 502
      ).json({

        success: false,

        message:
          result.timedOut
            ? "Proses download terlalu lama."
            : "Gagal memproses file media."

      });

    }


    let files: string[];


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


    const expectedExtension =
      audio
        ? ".mp3"
        : ".mp4";


    const outputFilename =
      files.find(
        file =>
          file
            .toLowerCase()
            .endsWith(
              expectedExtension
            )
      );


    if (!outputFilename) {

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


    const outputFile =
      path.join(
        tempDir,
        outputFilename
      );


    const stat =
      await fs.stat(
        outputFile
      );


    console.log(
      "[DOWNLOAD] Final file size:",
      stat.size,
      "bytes"
    );


    if (
      stat.size < 1024
    ) {

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


    const fileStream =
      createReadStream(
        outputFile
      );


    fileStream.on(
      "error",
      async error => {

        console.error(
          "[DOWNLOAD] File stream error:",
          error
        );


        try {

          await fs.rm(
            tempDir,
            {
              recursive: true,
              force: true
            }
          );

        } catch {
          // ignore
        }


        if (
          !res.headersSent
        ) {

          res.status(500).json({

            success: false,

            message:
              "Gagal mengirim file."

          });

        } else {

          res.destroy(
            error
          );

        }

      }
    );


    fileStream.on(
      "close",
      async () => {

        try {

          await fs.rm(
            tempDir,
            {
              recursive: true,
              force: true
            }
          );

        } catch {
          // ignore
        }


        console.log(
          "[DOWNLOAD] Temp files cleaned"
        );

      }
    );


    fileStream.pipe(res);

  }
);


/* =========================================================
   DOWNLOAD INSTAGRAM IMAGE
   ========================================================= */

app.post(
  "/api/download-image",
  async (req, res) => {

    const {
      url,
      imageUrl
    } = req.body ?? {};


    let targetImageUrl =
      "";


    /*
     * Preferred method:
     * Re-extract from original Instagram URL.
     */
    if (
      typeof url === "string" &&
      validPublicUrl(url) &&
      getInstagramPostUrl(url)
    ) {

      console.log(
        "[DOWNLOAD IMAGE] Re-extracting Instagram photo."
      );


      const photoResult =
        await extractInstagramSinglePhoto(
          url
        );


      if (
        photoResult.isSinglePhoto &&
        photoResult.photoUrl
      ) {

        targetImageUrl =
          photoResult.photoUrl;

      }

    }


    /*
     * Fallback:
     * Only accept known Instagram/Facebook CDN hosts.
     */
    if (
      !targetImageUrl &&
      typeof imageUrl === "string"
    ) {

      try {

        const parsed =
          new URL(imageUrl);


        const host =
          parsed.hostname
            .toLowerCase();


        const isAllowedHost =
          host === "cdninstagram.com" ||
          host.endsWith(".cdninstagram.com") ||
          host === "fbcdn.net" ||
          host.endsWith(".fbcdn.net");


        if (
          isAllowedHost
        ) {

          targetImageUrl =
            imageUrl;

        } else {

          console.warn(
            "[DOWNLOAD IMAGE] Rejected host:",
            host
          );

        }

      } catch {

        // invalid URL

      }

    }


    if (
      !targetImageUrl
    ) {

      return res.status(400).json({

        success: false,

        message:
          "Foto Instagram ini tidak dapat diproses saat ini."

      });

    }


    try {

      console.log(
        "[DOWNLOAD IMAGE] Fetching image."
      );


      const imgResponse =
        await fetch(
          targetImageUrl,
          {
            headers: {

              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36"

            }

          }
        );


      if (
        !imgResponse.ok
      ) {

        throw new Error(
          `Source returned HTTP ${imgResponse.status}`
        );

      }


      const contentType =
        (
          imgResponse
            .headers
            .get("content-type") ||
          ""
        )
          .split(";")[0]
          .trim()
          .toLowerCase();


      const allowedTypes:
        Record<string, string> = {

          "image/jpeg":
            "jpg",

          "image/png":
            "png",

          "image/webp":
            "webp",

          "image/gif":
            "gif",

          "image/avif":
            "avif"

        };


      let imageExt =
        allowedTypes[
          contentType
        ];


      if (
        !imageExt
      ) {

        imageExt =
          getExtensionFromUrl(
            targetImageUrl
          );

      }


      if (
        !isImageExtension(
          imageExt
        )
      ) {

        throw new Error(
          "Source bukan file gambar yang didukung."
        );

      }


      const buffer =
        Buffer.from(
          await imgResponse
            .arrayBuffer()
        );


      if (
        buffer.length === 0
      ) {

        throw new Error(
          "File gambar kosong."
        );

      }


      if (
        buffer.length >
        MAX_IMAGE_SIZE
      ) {

        return res.status(400).json({

          success: false,

          message:
            "File gambar terlalu besar."

        });

      }


      const filename =
        safeFilename(
          "LinkDrop_Instagram_Photo",
          imageExt
        );


      res.setHeader(
        "Content-Type",
        contentType ||
          `image/${imageExt}`
      );


      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );


      res.setHeader(
        "Content-Length",
        String(buffer.length)
      );


      return res.send(
        buffer
      );


    } catch (error: unknown) {

      const message =
        error instanceof Error
          ? error.message
          : String(error);


      console.error(
        "[DOWNLOAD IMAGE ERROR]:",
        message
      );


      if (
        !res.headersSent
      ) {

        return res.status(500).json({

          success: false,

          message:
            "Foto Instagram ini tidak dapat diproses saat ini."

        });

      }

    }

  }
);


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
