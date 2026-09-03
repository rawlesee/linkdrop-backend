/**
 * Letsedrop Production Server - Final
 * Entry: src/server.ts -> dist/server.js
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import dns from 'dns/promises';
import { URL } from 'url';
import crypto from 'crypto';
import { chromium, Browser, Route } from 'playwright-core';

const app = express();

const PORT = process.env.PORT || 3000;
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '500', 10);
const DOWNLOAD_TIMEOUT_MS = parseInt(
  process.env.DOWNLOAD_TIMEOUT_MS || '300000',
  10
);
const MAX_CONCURRENT_DOWNLOADS = parseInt(
  process.env.MAX_CONCURRENT_DOWNLOADS || '5',
  10
);

const MAX_INSTAGRAM_CAROUSEL_ITEMS = 30;
const TEMP_DIR = path.resolve(process.env.TEMP_DIR || './tmp');

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST'],
    exposedHeaders: [
      'Content-Disposition',
      'Content-Type',
      'Content-Length',
    ],
  })
);

app.use(express.json({ limit: '2mb' }));

let activeDownloadsCount = 0;

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.',
  },
});

app.use('/api/', apiLimiter);

const SUPPORTED_DOMAINS: { [key: string]: RegExp } = {
  tiktok: /^(www\.|vm\.|vt\.)?tiktok\.com$/i,
  youtube: /^(www\.|m\.)?(youtube\.com|youtu\.be)$/i,
  instagram: /^(www\.)?instagram\.com$/i,
  facebook: /^(www\.|m\.|web\.)?(facebook\.com|fb\.watch)$/i,
  twitter: /^(www\.)?(twitter\.com|x\.com)$/i,
  reddit: /^(www\.|old\.)?(reddit\.com|v\.redd\.it)$/i,
};

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class CommandExecutionError extends Error {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;

  constructor(
    message: string,
    code: number,
    stdout: string,
    stderr: string,
    timedOut = false
  ) {
    super(message);
    this.name = 'CommandExecutionError';
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
    this.timedOut = timedOut;
  }
}

async function validateUrlSafety(
  inputUrl: string
): Promise<{
  safe: boolean;
  platform?: string;
  error?: string;
}> {
  try {
    const parsed = new URL(inputUrl);

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        safe: false,
        error: 'Protokol URL harus HTTP atau HTTPS.',
      };
    }

    const hostname = parsed.hostname.toLowerCase();

    let matchedPlatform: string | undefined;

    for (const [platform, regex] of Object.entries(SUPPORTED_DOMAINS)) {
      if (regex.test(hostname)) {
        matchedPlatform = platform;
        break;
      }
    }

    if (!matchedPlatform) {
      return {
        safe: false,
        error: 'Platform ini belum didukung.',
      };
    }

    const addresses = await dns.lookup(hostname, { all: true });

    for (const addr of addresses) {
      const ip = addr.address;

      if (
        ip.startsWith('127.') ||
        ip.startsWith('10.') ||
        ip.startsWith('192.168.') ||
        ip.startsWith('169.254.') ||
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip) ||
        ip === '::1' ||
        ip.startsWith('fe80:') ||
        ip.startsWith('fc00:') ||
        ip.startsWith('fd00:')
      ) {
        return {
          safe: false,
          error: 'Akses ke IP privat/internal diblokir demi keamanan.',
        };
      }
    }

    return {
      safe: true,
      platform: matchedPlatform,
    };
  } catch {
    return {
      safe: false,
      error: 'Link tidak valid.',
    };
  }
}

function sanitizeFilename(rawTitle: string, ext: string): string {
  let clean = rawTitle
    .replace(/[^a-zA-Z0-9_\-\s]/g, '')
    .trim();

  if (!clean) {
    clean = 'Letsedrop_Media';
  }

  clean = clean
    .substring(0, 45)
    .replace(/\s+/g, '_');

  const safeExt =
    ext.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'jpg';

  return `${clean}_${Date.now().toString().slice(-4)}.${safeExt}`;
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs = 30000
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    console.log(
      `[EXEC] ${command} ${args.join(' ')} timeout=${timeoutMs}ms`
    );

    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;

      child.kill('SIGKILL');

      reject(
        new CommandExecutionError(
          'TIMEOUT',
          -1,
          stdout,
          stderr,
          true
        )
      );
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);

      reject(
        new CommandExecutionError(
          err.message,
          -1,
          stdout,
          stderr,
          false
        )
      );
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timer);

      if (timedOut) return;

      const exitCode = code ?? 1;

      if (exitCode === 0) {
        resolve({
          stdout,
          stderr,
          code: exitCode,
        });
      } else {
        reject(
          new CommandExecutionError(
            stderr.trim() ||
              `${command} gagal dengan exit code ${exitCode}`,
            exitCode,
            stdout,
            stderr,
            false
          )
        );
      }
    });
  });
}

export interface ExtractedMediaItem {
  index: number;
  type: 'image' | 'video';
  url: string;
  thumbnail: string;
  ext: string;
  width?: number;
  height?: number;
}

/**
 * ============================================================
 * INSTAGRAM POST EXTRACTOR
 *
 * SATU URL /p/... = SATU POSTINGAN
 *
 * Maksimal 30 media:
 * - foto
 * - video
 * - campuran foto + video
 *
 * Tidak mengambil seluruh <img> dari halaman.
 * ============================================================
 */
async function extractInstagramWithPlaywright(
  targetUrl: string
): Promise<{
  success: boolean;
  isVideoPost?: boolean;
  title?: string;
  thumbnail?: string;
  items?: ExtractedMediaItem[];
  error?: string;
}> {
  let browser: Browser | null = null;

  console.log(
    `[INSTAGRAM] Extraction started: ${targetUrl}`
  );

  try {
    browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_PATH || '/usr/bin/chromium',

      headless: true,

      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',

      viewport: {
        width: 1280,
        height: 900,
      },

      deviceScaleFactor: 1,
    });

    const page = await context.newPage();

    await page.route('**/*', (route: Route) => {
      const reqUrl = route.request().url().toLowerCase();

      if (
        reqUrl.includes('google-analytics') ||
        reqUrl.includes('facebook.com/tr') ||
        reqUrl.includes('logging') ||
        reqUrl.includes(
          'static.cdninstagram.com/rsrc.php'
        )
      ) {
        return route.abort();
      }

      return route.continue();
    });

    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });

    const finalUrl = page.url();

    if (
      finalUrl.includes('/accounts/login') ||
      finalUrl.includes('login_required')
    ) {
      return {
        success: false,
        error:
          'Media ini tidak dapat diakses karena bersifat privat atau membutuhkan login.',
      };
    }

    await page.waitForTimeout(1800);

    /**
     * PENTING:
     * Hanya ambil ARTICLE pertama.
     * Ini adalah postingan yang sedang dibuka,
     * bukan seluruh halaman Instagram.
     */
    const article = page.locator('article').first();

    if (!(await article.count())) {
      return {
        success: false,
        error: 'Postingan Instagram tidak ditemukan.',
      };
    }

    /**
     * Ambil media aktif dari ARTICLE.
     */
    const getCurrentMedia =
      async (): Promise<ExtractedMediaItem | null> => {
        return await article.evaluate(() => {
          const allowedDomains = [
            'cdninstagram.com',
            'fbcdn.net',
            'lookaside.fbsbx.com',
          ];

          const isAllowedUrl = (
            value: string
          ): boolean => {
            try {
              const u = new URL(value);

              if (
                u.hostname.includes(
                  'static.cdninstagram.com'
                )
              ) {
                return false;
              }

              return allowedDomains.some((domain) =>
                u.hostname.endsWith(domain)
              );
            } catch {
              return false;
            }
          };

          const candidates: Array<{
            type: 'image' | 'video';
            url: string;
            thumbnail: string;
            width: number;
            height: number;
            area: number;
          }> = [];

          /**
           * VIDEO
           */
          const videos = Array.from(
            document.querySelectorAll('video')
          ) as HTMLVideoElement[];

          for (const video of videos) {
            const source =
              video.currentSrc ||
              video.src ||
              video.querySelector('source')?.src ||
              '';

            if (
              !source ||
              !isAllowedUrl(source)
            ) {
              continue;
            }

            const width =
              video.videoWidth ||
              video.clientWidth ||
              0;

            const height =
              video.videoHeight ||
              video.clientHeight ||
              0;

            if (width < 220 || height < 220) {
              continue;
            }

            const poster =
              video.poster &&
              isAllowedUrl(video.poster)
                ? video.poster
                : source;

            candidates.push({
              type: 'video',
              url: source,
              thumbnail: poster,
              width,
              height,
              area: width * height,
            });
          }

          /**
           * IMAGE
           */
          const images = Array.from(
            document.querySelectorAll('img')
          ) as HTMLImageElement[];

          for (const img of images) {
            const src =
              img.currentSrc ||
              img.src ||
              '';

            if (
              !src ||
              !isAllowedUrl(src)
            ) {
              continue;
            }

            const width =
              img.naturalWidth ||
              img.clientWidth ||
              0;

            const height =
              img.naturalHeight ||
              img.clientHeight ||
              0;

            if (width < 220 || height < 220) {
              continue;
            }

            candidates.push({
              type: 'image',
              url: src,
              thumbnail: src,
              width,
              height,
              area: width * height,
            });
          }

          /**
           * Media terbesar dianggap media utama
           * dari slide yang sedang aktif.
           */
          candidates.sort(
            (a, b) => b.area - a.area
          );

          const best = candidates[0];

          if (!best) {
            return null;
          }

          return {
            index: 0,
            type: best.type,
            url: best.url,
            thumbnail: best.thumbnail,
            ext:
              best.type === 'video'
                ? 'mp4'
                : 'jpg',
            width: best.width,
            height: best.height,
          };
        });
      };

    const items: ExtractedMediaItem[] = [];
    const seenUrls = new Set<string>();

    /**
     * Maksimal 30 slide.
     */
    for (
      let slide = 0;
      slide < MAX_INSTAGRAM_CAROUSEL_ITEMS;
      slide++
    ) {
      const media =
        await getCurrentMedia();

      if (!media) {
        break;
      }

      if (!seenUrls.has(media.url)) {
        seenUrls.add(media.url);

        media.index = items.length;

        items.push(media);

        console.log(
          `[INSTAGRAM] Slide ${items.length}: ${media.type}`
        );
      }

      /**
       * Cari Next hanya di ARTICLE target.
       */
      const nextButton = article
        .locator(
          'button[aria-label*="Next"],' +
            'button[aria-label*="next"],' +
            'button[aria-label*="Selanjutnya"],' +
            'button[aria-label*="Berikutnya"]'
        )
        .first();

      if (!(await nextButton.count())) {
        break;
      }

      if (
        !(await nextButton
          .isVisible()
          .catch(() => false))
      ) {
        break;
      }

      const currentUrl = media.url;

      try {
        await nextButton.click({
          timeout: 2000,
        });
      } catch {
        break;
      }

      /**
       * Tunggu media berubah.
       */
      let changed = false;

      for (let retry = 0; retry < 6; retry++) {
        await page.waitForTimeout(350);

        const nextMedia =
          await getCurrentMedia();

        if (
          nextMedia &&
          nextMedia.url !== currentUrl
        ) {
          changed = true;
          break;
        }
      }

      if (!changed) {
        break;
      }
    }

    console.log(
      `[INSTAGRAM] Total media target post: ${items.length}`
    );

    if (items.length === 0) {
      return {
        success: false,
        error:
          'Tidak dapat menemukan media pada postingan Instagram ini.',
      };
    }

    /**
     * SATU VIDEO:
     * diteruskan ke yt-dlp.
     */
    if (
      items.length === 1 &&
      items[0].type === 'video'
    ) {
      return {
        success: true,
        isVideoPost: true,
        thumbnail:
          items[0].thumbnail,
      };
    }

    let pageTitle =
      'Instagram Post';

    try {
      const metaDesc =
        await page
          .locator(
            'meta[property="og:title"], meta[name="description"]'
          )
          .first()
          .getAttribute(
            'content'
          );

      if (metaDesc) {
        pageTitle =
          metaDesc
            .substring(0, 70)
            .trim();
      }
    } catch {}

    return {
      success: true,
      isVideoPost: false,
      title: pageTitle,
      thumbnail:
        items[0].thumbnail,
      items,
    };
  } catch (err: unknown) {
    const msg =
      err instanceof Error
        ? err.message
        : String(err);

    console.error(
      '[INSTAGRAM] Playwright error:',
      msg
    );

    return {
      success: false,
      error: msg,
    };
  } finally {
    if (browser) {
      await browser
        .close()
        .catch(() => {});
    }
  }
}

// ============================================================
// HEALTH
// ============================================================

app.get(
  '/api/health',
  (_req: Request, res: Response): void => {
    res.json({
      status: 'ok',
      timestamp:
        new Date().toISOString(),
      activeDownloads:
        activeDownloadsCount,
    });
  }
);

// ============================================================
// ANALYZE
// ============================================================

app.post(
  '/api/analyze',
  async (
    req: Request,
    res: Response
  ): Promise<void> => {
    const { url } = req.body;

    if (
      !url ||
      typeof url !== 'string'
    ) {
      res.status(400).json({
        success: false,
        message:
          'URL publik yang didukung diperlukan.',
      });
      return;
    }

    const safety =
      await validateUrlSafety(url);

    if (!safety.safe) {
      res.status(400).json({
        success: false,
        message:
          safety.error ||
          'Link tidak dapat diproses.',
      });
      return;
    }

    /**
     * INSTAGRAM POST
     */
    if (
      safety.platform ===
        'instagram' &&
      url.includes('/p/')
    ) {
      console.log(
        `[ANALYZE] Instagram post: ${url}`
      );

      const igResult =
        await extractInstagramWithPlaywright(
          url
        );

      /**
       * Carousel / foto.
       */
      if (
        igResult.success &&
        !igResult.isVideoPost &&
        igResult.items &&
        igResult.items.length > 0
      ) {
        res.json({
          success: true,
          platform:
            'instagram',
          type: 'image',
          title:
            igResult.title ||
            'Foto Instagram',
          thumbnail:
            igResult.thumbnail ||
            igResult.items[0].url,
          uploader:
            'Instagram User',
          items:
            igResult.items,
          url,
        });

        return;
      }

      /**
       * Single video.
       */
      if (
        igResult.isVideoPost
      ) {
        console.log(
          '[ANALYZE] Instagram single video -> yt-dlp'
        );
      } else if (
        igResult.error
      ) {
        console.warn(
          `[ANALYZE] Instagram extractor: ${igResult.error}`
        );
      }
    }

    /**
     * VIDEO PIPELINE
     */
    try {
      const args = [
        '--dump-json',
        '--no-playlist',
        '--skip-download',
        '--no-warnings',
        '--no-check-certificates',
        url,
      ];

      const { stdout } =
        await runCommand(
          'yt-dlp',
          args,
          25000
        );

      const meta =
        JSON.parse(stdout);

      res.json({
        success: true,
        platform:
          safety.platform,
        type: 'video',
        title:
          meta.title ||
          'Letsedrop Video',
        thumbnail:
          meta.thumbnail || '',
        uploader:
          meta.uploader ||
          meta.channel ||
          'Publik',
        duration:
          meta.duration || 0,
        url,
        formats: [
          {
            id: 'best',
            label:
              'Video MP4 (HD)',
            extension: 'mp4',
            quality: 'HD',
            type: 'video',
          },
          {
            id: 'audio',
            label:
              'Audio MP3',
            extension: 'mp3',
            quality:
              'High Audio',
            type: 'audio',
          },
        ],
      });
    } catch (err: unknown) {
      const errorMsg =
        err instanceof Error
          ? err.message
          : String(err);

      console.error(
        '[Analyze Error]',
        errorMsg
      );

      if (
        safety.platform ===
        'instagram'
      ) {
        res.status(400).json({
          success: false,
          message:
            'Foto/media Instagram ini tidak dapat diproses saat ini.',
        });
        return;
      }

      const errLower =
        errorMsg.toLowerCase();

      if (
        errLower.includes(
          'private'
        ) ||
        errLower.includes(
          'login'
        )
      ) {
        res.status(400).json({
          success: false,
          message:
            'Media ini tidak dapat diakses karena bersifat privat atau membutuhkan login.',
        });
        return;
      }

      res.status(500).json({
        success: false,
        message:
          'Media tidak tersedia atau tidak dapat diproses saat ini.',
      });
    }
  }
);

// ============================================================
// DOWNLOAD VIDEO / AUDIO
// ============================================================

app.post(
  '/api/download',
  async (
    req: Request,
    res: Response
  ): Promise<void> => {
    const { url, formatId } =
      req.body;

    if (
      !url ||
      typeof url !== 'string'
    ) {
      res.status(400).json({
        success: false,
        message:
          'URL publik yang didukung diperlukan.',
      });
      return;
    }

    const safety =
      await validateUrlSafety(url);

    if (!safety.safe) {
      res.status(400).json({
        success: false,
        message:
          safety.error,
      });
      return;
    }

    if (
      activeDownloadsCount >=
      MAX_CONCURRENT_DOWNLOADS
    ) {
      res.status(503).json({
        success: false,
        message:
          'Server sibuk. Coba beberapa saat lagi.',
      });
      return;
    }

    activeDownloadsCount++;

    const isAudio =
      formatId === 'audio';

    const ext =
      isAudio ? 'mp3' : 'mp4';

    const jobId =
      crypto
        .randomBytes(8)
        .toString('hex');

    const tempOutputTemplate =
      path.join(
        TEMP_DIR,
        `${jobId}.%(ext)s`
      );

    let finalFilePath = '';

    try {
      const args = [
        '--no-playlist',
        '--no-warnings',
        '--no-check-certificates',
        '--max-filesize',
        `${MAX_FILE_SIZE_MB}m`,
        '-f',
        isAudio
          ? 'bestaudio/best'
          : 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '-o',
        tempOutputTemplate,
      ];

      if (isAudio) {
        args.push(
          '--extract-audio',
          '--audio-format',
          'mp3'
        );
      } else {
        args.push(
          '--merge-output-format',
          'mp4'
        );
      }

      args.push(url);

      await runCommand(
        'yt-dlp',
        args,
        DOWNLOAD_TIMEOUT_MS
      );

      const files =
        fs.readdirSync(
          TEMP_DIR
        );

      const matched =
        files.find((f) =>
          f.startsWith(jobId)
        );

      if (!matched) {
        throw new Error(
          'File hasil download tidak ditemukan.'
        );
      }

      finalFilePath =
        path.join(
          TEMP_DIR,
          matched
        );

      const stats =
        fs.statSync(
          finalFilePath
        );

      const safeFilename =
        sanitizeFilename(
          `Letsedrop_${safety.platform || 'Media'}`,
          ext
        );

      const mimeType =
        isAudio
          ? 'audio/mpeg'
          : 'video/mp4';

      res.setHeader(
        'Content-Type',
        mimeType
      );

      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${safeFilename}"`
      );

      res.setHeader(
        'Content-Length',
        stats.size
      );

      const fileStream =
        fs.createReadStream(
          finalFilePath
        );

      fileStream.pipe(res);

      const cleanup =
        () => {
          try {
            if (
              finalFilePath &&
              fs.existsSync(
                finalFilePath
              )
            ) {
              fs.unlinkSync(
                finalFilePath
              );
            }
          } catch {}
        };

      res.on(
        'finish',
        cleanup
      );

      res.on(
        'close',
        cleanup
      );
    } catch (err: unknown) {
      const errorMsg =
        err instanceof Error
          ? err.message
          : String(err);

      console.error(
        '[Download Error]',
        errorMsg
      );

      if (
        finalFilePath &&
        fs.existsSync(
          finalFilePath
        )
      ) {
        try {
          fs.unlinkSync(
            finalFilePath
          );
        } catch {}
      }

      if (
        !res.headersSent
      ) {
        res.status(500).json({
          success: false,
          message:
            'Gagal memproses download media.',
        });
      }
    } finally {
      activeDownloadsCount =
        Math.max(
          0,
          activeDownloadsCount - 1
        );
    }
  }
);

// ============================================================
// DOWNLOAD IMAGE
// ============================================================

app.post(
  '/api/download-image',
  async (
    req: Request,
    res: Response
  ): Promise<void> => {
    const {
      url,
      imageUrl,
      itemIndex,
    } = req.body;

    let targetImageUrl =
      '';

    if (
      imageUrl &&
      typeof imageUrl ===
        'string'
    ) {
      try {
        const parsed =
          new URL(imageUrl);

        const host =
          parsed.hostname.toLowerCase();

        const isAllowedHost =
          (
            host.endsWith(
              'cdninstagram.com'
            ) &&
            !host.includes(
              'static.cdninstagram.com'
            )
          ) ||
          host.endsWith(
            'fbcdn.net'
          ) ||
          host.endsWith(
            'lookaside.fbsbx.com'
          );

        if (isAllowedHost) {
          targetImageUrl =
            imageUrl;
        }
      } catch {}
    }

    if (
      !targetImageUrl &&
      url &&
      typeof url === 'string'
    ) {
      const safety =
        await validateUrlSafety(
          url
        );

      if (
        safety.safe &&
        safety.platform ===
          'instagram'
      ) {
        const extraction =
          await extractInstagramWithPlaywright(
            url
          );

        const targetIndex =
          typeof itemIndex ===
          'number'
            ? itemIndex
            : 0;

        const item =
          extraction.items?.[
            targetIndex
          ];

        if (
          item &&
          item.type ===
            'image'
        ) {
          targetImageUrl =
            item.url;
        }
      }
    }

    if (!targetImageUrl) {
      res.status(400).json({
        success: false,
        message:
          'Foto Instagram ini tidak dapat diproses saat ini.',
      });
      return;
    }

    try {
      const parsed =
        new URL(
          targetImageUrl
        );

      const controller =
        new AbortController();

      const timer =
        setTimeout(
          () =>
            controller.abort(),
          20000
        );

      const imgResponse =
        await fetch(
          targetImageUrl,
          {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',

              Accept:
                'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            },

            signal:
              controller.signal,
          }
        );

      clearTimeout(timer);

      if (
        !imgResponse.ok
      ) {
        throw new Error(
          `Upstream status ${imgResponse.status}`
        );
      }

      const buffer =
        Buffer.from(
          await imgResponse.arrayBuffer()
        );

      if (
        buffer.length >
        MAX_FILE_SIZE_MB *
          1024 *
          1024
      ) {
        res.status(400).json({
          success: false,
          message:
            'File terlalu besar untuk diproses.',
        });
        return;
      }

      const contentType =
        imgResponse.headers.get(
          'content-type'
        ) ||
        'image/jpeg';

      let fileExt = 'jpg';

      if (
        contentType.includes(
          'webp'
        )
      ) {
        fileExt = 'webp';
      } else if (
        contentType.includes(
          'png'
        )
      ) {
        fileExt = 'png';
      }

      const indexSuffix =
        typeof itemIndex ===
        'number'
          ? `_${itemIndex + 1}`
          : '';

      const filename =
        sanitizeFilename(
          `Letsedrop_Instagram_Photo${indexSuffix}`,
          fileExt
        );

      res.setHeader(
        'Content-Type',
        contentType
      );

      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`
      );

      res.setHeader(
        'Content-Length',
        buffer.length
      );

      res.send(buffer);

      console.log(
        `[DOWNLOAD IMAGE] ${parsed.hostname}`
      );
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : String(err);

      console.error(
        '[Download Image Error]',
        msg
      );

      if (
        !res.headersSent
      ) {
        res.status(500).json({
          success: false,
          message:
            'Foto Instagram ini tidak dapat diproses saat ini.',
        });
      }
    }
  }
);

// ============================================================
// DOWNLOAD CAROUSEL MEDIA
//
// Endpoint tambahan untuk frontend.
// Bisa menerima mediaUrl langsung dari hasil Analyze.
// ============================================================

app.post(
  '/api/download-carousel',
  async (
    req: Request,
    res: Response
  ): Promise<void> => {
    const {
      mediaUrl,
      type,
      itemIndex,
    } = req.body;

    if (
      !mediaUrl ||
      typeof mediaUrl !==
        'string'
    ) {
      res.status(400).json({
        success: false,
        message:
          'URL media diperlukan.',
      });
      return;
    }

    if (
      type !== 'image' &&
      type !== 'video'
    ) {
      res.status(400).json({
        success: false,
        message:
          'Jenis media tidak valid.',
      });
      return;
    }

    try {
      const parsed =
        new URL(mediaUrl);

      const host =
        parsed.hostname.toLowerCase();

      const allowed =
        (
          host.endsWith(
            'cdninstagram.com'
          ) &&
          !host.includes(
            'static.cdninstagram.com'
          )
        ) ||
        host.endsWith(
          'fbcdn.net'
        ) ||
        host.endsWith(
          'lookaside.fbsbx.com'
        );

      if (!allowed) {
        res.status(400).json({
          success: false,
          message:
            'Host media tidak diizinkan.',
        });
        return;
      }

      const controller =
        new AbortController();

      const timer =
        setTimeout(
          () =>
            controller.abort(),
          30000
        );

      const upstream =
        await fetch(
          mediaUrl,
          {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',

              Accept:
                type === 'video'
                  ? 'video/mp4,video/*,*/*;q=0.8'
                  : 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            },

            signal:
              controller.signal,
          }
        );

      clearTimeout(timer);

      if (!upstream.ok) {
        throw new Error(
          `Upstream status ${upstream.status}`
        );
      }

      const buffer =
        Buffer.from(
          await upstream.arrayBuffer()
        );

      if (
        buffer.length >
        MAX_FILE_SIZE_MB *
          1024 *
          1024
      ) {
        res.status(400).json({
          success: false,
          message:
            'File terlalu besar.',
        });
        return;
      }

      const contentType =
        upstream.headers.get(
          'content-type'
        ) ||
        (type === 'video'
          ? 'video/mp4'
          : 'image/jpeg');

      let ext =
        type === 'video'
          ? 'mp4'
          : 'jpg';

      if (
        contentType.includes(
          'webp'
        )
      ) {
        ext = 'webp';
      } else if (
        contentType.includes(
          'png'
        )
      ) {
        ext = 'png';
      } else if (
        contentType.includes(
          'webm'
        )
      ) {
        ext = 'webm';
      }

      const suffix =
        typeof itemIndex ===
        'number'
          ? `_${itemIndex + 1}`
          : '';

      const filename =
        sanitizeFilename(
          `Letsedrop_Instagram_${type}${suffix}`,
          ext
        );

      res.setHeader(
        'Content-Type',
        contentType
      );

      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`
      );

      res.setHeader(
        'Content-Length',
        buffer.length
      );

      res.send(buffer);
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : String(err);

      console.error(
        '[Carousel Download Error]',
        msg
      );

      if (
        !res.headersSent
      ) {
        res.status(500).json({
          success: false,
          message:
            'Media carousel tidak dapat didownload saat ini.',
        });
      }
    }
  }
);

// ============================================================
// DEBUG INSTAGRAM
// ============================================================

app.get(
  '/api/debug-instagram',
  async (
    req: Request,
    res: Response
  ): Promise<void> => {
    const rawUrl =
      req.query.url;

    if (
      !rawUrl ||
      typeof rawUrl !==
        'string'
    ) {
      res.status(400).json({
        success: false,
        message:
          'Query parameter url diperlukan.',
      });
      return;
    }

    const safety =
      await validateUrlSafety(
        rawUrl
      );

    if (
      !safety.safe ||
      safety.platform !==
        'instagram'
    ) {
      res.status(400).json({
        success: false,
        message:
          'URL harus berupa URL Instagram publik yang valid dan aman.',
      });
      return;
    }

    let canonicalUrl =
      rawUrl.trim();

    try {
      const u =
        new URL(
          canonicalUrl
        );

      u.search = '';

      canonicalUrl =
        u.toString();
    } catch {}

    const extraction =
      await extractInstagramWithPlaywright(
        canonicalUrl
      );

    res.json({
      success:
        extraction.success,
      url:
        canonicalUrl,
      isVideoPost:
        extraction.isVideoPost ||
        false,
      title:
        extraction.title ||
        '',
      thumbnail:
        extraction.thumbnail ||
        '',
      itemCount:
        extraction.items?.length ||
        0,
      items:
        extraction.items ||
        [],
      error:
        extraction.error ||
        null,
    });
  }
);

// ============================================================
// CLEANUP TEMP FILES
// ============================================================

setInterval(() => {
  try {
    const now =
      Date.now();

    const files =
      fs.readdirSync(
        TEMP_DIR
      );

    for (const file of files) {
      const fullPath =
        path.join(
          TEMP_DIR,
          file
        );

      const stat =
        fs.statSync(
          fullPath
        );

      if (
        now - stat.mtimeMs >
        15 * 60 * 1000
      ) {
        fs.unlinkSync(
          fullPath
        );
      }
    }
  } catch {}
}, 10 * 60 * 1000);

// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  () => {
    console.log(
      `[Letsedrop Server] Running on port ${PORT}`
    );

    console.log(
      `[Letsedrop Server] Temp directory: ${TEMP_DIR}`
    );

    console.log(
      `[Letsedrop Server] Chromium: ${
        process.env.CHROMIUM_PATH ||
        '/usr/bin/chromium'
      }`
    );
  }
);
