/**
 * LinkDrop Production Server
 * Entry Point: src/server.ts -> dist/server.js
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

const app = express();

/* =========================================================
   CONFIG
   ========================================================= */

const PORT = Number(process.env.PORT) || 3000;

const MAX_FILE_SIZE_MB = parseInt(
  process.env.MAX_FILE_SIZE_MB || '500',
  10
);

const DOWNLOAD_TIMEOUT_MS = parseInt(
  process.env.DOWNLOAD_TIMEOUT_MS || '300000',
  10
);

const MAX_CONCURRENT_DOWNLOADS = parseInt(
  process.env.MAX_CONCURRENT_DOWNLOADS || '5',
  10
);

const TEMP_DIR = path.resolve(
  process.env.TEMP_DIR || './tmp'
);

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/* =========================================================
   SECURITY / MIDDLEWARE
   ========================================================= */

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: {
      policy: 'cross-origin',
    },
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

app.use(
  express.json({
    limit: '2mb',
  })
);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message:
      'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.',
  },
});

app.use('/api/', apiLimiter);

/* =========================================================
   GLOBAL DOWNLOAD LIMIT
   ========================================================= */

let activeDownloadsCount = 0;

/* =========================================================
   SUPPORTED DOMAINS
   ========================================================= */

const SUPPORTED_DOMAINS: Record<string, RegExp> = {
  tiktok: /^(www\.|vm\.|vt\.)?tiktok\.com$/i,

  youtube:
    /^(www\.|m\.)?(youtube\.com|youtu\.be)$/i,

  instagram:
    /^(www\.)?instagram\.com$/i,

  facebook:
    /^(www\.|m\.|web\.)?(facebook\.com|fb\.watch)$/i,

  twitter:
    /^(www\.)?(twitter\.com|x\.com)$/i,

  reddit:
    /^(www\.|old\.)?(reddit\.com|v\.redd\.it)$/i,
};

/* =========================================================
   ALLOWED IMAGE HOSTS
   ========================================================= */

function isAllowedInstagramImageHost(
  hostname: string
): boolean {
  const host =
    hostname.toLowerCase();

  return (
    host === 'cdninstagram.com' ||
    host.endsWith('.cdninstagram.com') ||
    host === 'fbcdn.net' ||
    host.endsWith('.fbcdn.net')
  );
}

/* =========================================================
   COMMAND TYPES
   ========================================================= */

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

    this.name =
      'CommandExecutionError';

    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
    this.timedOut = timedOut;
  }
}

/* =========================================================
   URL / SSRF VALIDATION
   ========================================================= */

async function validateUrlSafety(
  inputUrl: string
): Promise<{
  safe: boolean;
  platform?: string;
  error?: string;
}> {
  try {
    const parsed =
      new URL(inputUrl);

    if (
      parsed.protocol !== 'http:' &&
      parsed.protocol !== 'https:'
    ) {
      return {
        safe: false,
        error:
          'Protokol URL harus HTTP atau HTTPS.',
      };
    }

    const hostname =
      parsed.hostname.toLowerCase();

    let matchedPlatform:
      string | undefined;

    for (const [
      platform,
      regex,
    ] of Object.entries(
      SUPPORTED_DOMAINS
    )) {
      if (regex.test(hostname)) {
        matchedPlatform =
          platform;
        break;
      }
    }

    if (!matchedPlatform) {
      return {
        safe: false,
        error:
          'Platform ini belum didukung.',
      };
    }

    const addresses =
      await dns.lookup(
        hostname,
        {
          all: true,
        }
      );

    for (const addr of addresses) {
      const ip =
        addr.address;

      if (
        ip.startsWith('127.') ||
        ip.startsWith('10.') ||
        ip.startsWith('192.168.') ||
        ip.startsWith('169.254.') ||
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(
          ip
        ) ||
        ip === '::1' ||
        ip.startsWith('fe80:') ||
        ip.startsWith('fc00:') ||
        ip.startsWith('fd00:')
      ) {
        return {
          safe: false,
          error:
            'Akses ke IP privat/internal diblokir demi keamanan.',
        };
      }
    }

    return {
      safe: true,
      platform:
        matchedPlatform,
    };
  } catch {
    return {
      safe: false,
      error:
        'Link tidak valid.',
    };
  }
}

/* =========================================================
   FILENAME
   ========================================================= */

function sanitizeFilename(
  rawTitle: string,
  ext: string
): string {
  let clean =
    rawTitle
      .replace(
        /[^a-zA-Z0-9_\-\s]/g,
        ''
      )
      .trim();

  if (!clean) {
    clean =
      'LinkDrop_Media';
  }

  clean =
    clean
      .substring(0, 45)
      .replace(
        /\s+/g,
        '_'
      );

  const safeExt =
    ext
      .replace(
        /[^a-zA-Z0-9]/g,
        ''
      )
      .toLowerCase() ||
    'jpg';

  return `${clean}_${Date.now()
    .toString()
    .slice(-4)}.${safeExt}`;
}

/* =========================================================
   RUN COMMAND
   ========================================================= */

function runCommand(
  command: string,
  args: string[],
  timeoutMs = 30000
): Promise<CommandResult> {
  return new Promise(
    (
      resolve,
      reject
    ) => {
      console.log(
        `[EXEC] Menjalankan: ${command} ${args.join(
          ' '
        )} (timeout: ${timeoutMs}ms)`
      );

      const child =
        spawn(
          command,
          args,
          {
            shell: false,
            windowsHide: true,
          }
        );

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const timer =
        setTimeout(
          () => {
            if (settled)
              return;

            timedOut = true;

            console.error(
              `[TIMEOUT] Perintah ${command} dimatikan setelah ${timeoutMs}ms`
            );

            child.kill(
              'SIGKILL'
            );

            settled = true;

            reject(
              new CommandExecutionError(
                'TIMEOUT',
                -1,
                stdout,
                stderr,
                true
              )
            );
          },
          timeoutMs
        );

      child.stdout?.on(
        'data',
        (
          chunk:
            | Buffer
            | string
        ) => {
          stdout +=
            chunk.toString();
        }
      );

      child.stderr?.on(
        'data',
        (
          chunk:
            | Buffer
            | string
        ) => {
          stderr +=
            chunk.toString();
        }
      );

      child.on(
        'error',
        (
          err: Error
        ) => {
          if (settled)
            return;

          clearTimeout(
            timer
          );

          settled = true;

          console.error(
            `[SPAWN ERROR] ${command}:`,
            err.message
          );

          reject(
            new CommandExecutionError(
              err.message,
              -1,
              stdout,
              stderr,
              false
            )
          );
        }
      );

      child.on(
        'close',
        (
          code: number | null
        ) => {
          if (
            settled ||
            timedOut
          ) {
            return;
          }

          clearTimeout(
            timer
          );

          settled = true;

          const exitCode =
            code !== null
              ? code
              : 1;

          console.log(
            `[EXIT] ${command} selesai dengan exit code: ${exitCode}`
          );

          if (
            stderr.trim()
          ) {
            console.log(
              `[STDERR LOG] ${command}:`,
              stderr
                .trim()
                .substring(
                  0,
                  300
                )
            );
          }

          if (
            exitCode === 0
          ) {
            resolve({
              stdout,
              stderr,
              code:
                exitCode,
            });
          } else {
            const errorMsg =
              stderr.trim() ||
              `${command} gagal dengan exit code ${exitCode}`;

            reject(
              new CommandExecutionError(
                errorMsg,
                exitCode,
                stdout,
                stderr,
                false
              )
            );
          }
        }
      );
    }
  );
}

/* =========================================================
   HTML ENTITY DECODER
   ========================================================= */

function decodeHtmlEntities(
  value: string
): string {
  return value
    .replace(
      /&amp;/gi,
      '&'
    )
    .replace(
      /&quot;/gi,
      '"'
    )
    .replace(
      /&#39;/gi,
      "'"
    )
    .replace(
      /&#x27;/gi,
      "'"
    )
    .replace(
      /&lt;/gi,
      '<'
    )
    .replace(
      /&gt;/gi,
      '>'
    );
}

/* =========================================================
   META TAG EXTRACTOR
   ========================================================= */

function getMetaContent(
  html: string,
  property: string
): string {
  const escaped =
    property.replace(
      /[-/\\^$*+?.()|[\]{}]/g,
      '\\$&'
    );

  const patterns = [
    new RegExp(
      `<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      'i'
    ),

    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["'][^>]*>`,
      'i'
    ),

    new RegExp(
      `<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      'i'
    ),

    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escaped}["'][^>]*>`,
      'i'
    ),
  ];

  for (
    const pattern of patterns
  ) {
    const match =
      html.match(pattern);

    if (
      match &&
      match[1]
    ) {
      return decodeHtmlEntities(
        match[1]
      );
    }
  }

  return '';
}

/* =========================================================
   INSTAGRAM HTML PHOTO EXTRACTOR
   ========================================================= */

async function extractInstagramFromHtml(
  targetUrl: string
): Promise<{
  isSinglePhoto: boolean;
  isVideoPost?: boolean;
  title?: string;
  photoUrl?: string;
  ext?: string;
  error?: string;
}> {
  try {
    console.log(
      `[INSTAGRAM HTML] Mengambil halaman publik: ${targetUrl}`
    );

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () =>
          controller.abort(),
        20000
      );

    const response =
      await fetch(
        targetUrl,
        {
          method: 'GET',

          redirect:
            'follow',

          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',

            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',

            'Accept-Language':
              'en-US,en;q=0.9',

            'Cache-Control':
              'no-cache',

            Pragma:
              'no-cache',
          },

          signal:
            controller.signal,
        }
      );

    clearTimeout(
      timeout
    );

    if (
      !response.ok
    ) {
      return {
        isSinglePhoto:
          false,

        error:
          `Instagram mengembalikan HTTP ${response.status}.`,
      };
    }

    const finalUrl =
      response.url;

    if (
      finalUrl.includes(
        '/accounts/login'
      )
    ) {
      return {
        isSinglePhoto:
          false,

        error:
          'Instagram mengarahkan halaman ke login.',
      };
    }

    const html =
      await response.text();

    if (
      !html ||
      html.length < 100
    ) {
      return {
        isSinglePhoto:
          false,

        error:
          'HTML Instagram kosong.',
      };
    }

    /*
     * Deteksi video.
     *
     * og:image juga tersedia pada video,
     * jadi jangan menganggap keberadaan og:image
     * otomatis berarti foto.
     */

    const ogVideo =
      getMetaContent(
        html,
        'og:video'
      );

    const hasVideoMarkers =
      /"is_video"\s*:\s*true/i.test(
        html
      ) ||
      /"video_versions"/i.test(
        html
      ) ||
      /"video_url"/i.test(
        html
      );

    if (
      ogVideo ||
      hasVideoMarkers
    ) {
      console.log(
        '[INSTAGRAM HTML] Postingan terdeteksi sebagai video.'
      );

      return {
        isSinglePhoto:
          false,

        isVideoPost:
          true,
      };
    }

    /*
     * Ambil og:image.
     */

    const imageUrl =
      getMetaContent(
        html,
        'og:image'
      );

    if (!imageUrl) {
      return {
        isSinglePhoto:
          false,

        error:
          'Meta og:image tidak ditemukan pada halaman Instagram.',
      };
    }

    let parsedImageUrl:
      URL;

    try {
      parsedImageUrl =
        new URL(
          imageUrl
        );
    } catch {
      return {
        isSinglePhoto:
          false,

        error:
          'URL og:image Instagram tidak valid.',
      };
    }

    if (
      parsedImageUrl.protocol !==
        'https:' &&
      parsedImageUrl.protocol !==
        'http:'
    ) {
      return {
        isSinglePhoto:
          false,

        error:
          'Protokol gambar Instagram tidak valid.',
      };
    }

    /*
     * Security:
     * hanya izinkan CDN yang memang digunakan
     * untuk media Instagram/Meta.
     */

    if (
      !isAllowedInstagramImageHost(
        parsedImageUrl.hostname
      )
    ) {
      console.warn(
        `[INSTAGRAM HTML] Host gambar ditolak: ${parsedImageUrl.hostname}`
      );

      return {
        isSinglePhoto:
          false,

        error:
          'Host gambar Instagram tidak diizinkan.',
      };
    }

    const title =
      getMetaContent(
        html,
        'og:title'
      ) ||
      'Instagram Photo';

    let ext =
      'jpg';

    const contentType =
      getMetaContent(
        html,
        'og:image:type'
      ).toLowerCase();

    const pathname =
      parsedImageUrl.pathname.toLowerCase();

    if (
      contentType.includes(
        'png'
      ) ||
      pathname.endsWith(
        '.png'
      )
    ) {
      ext =
        'png';
    } else if (
      contentType.includes(
        'webp'
      ) ||
      pathname.endsWith(
        '.webp'
      )
    ) {
      ext =
        'webp';
    } else if (
      contentType.includes(
        'jpeg'
      ) ||
      pathname.endsWith(
        '.jpeg'
      ) ||
      pathname.endsWith(
        '.jpg'
      )
    ) {
      ext =
        'jpg';
    }

    console.log(
      '[INSTAGRAM HTML] og:image berhasil ditemukan.'
    );

    return {
      isSinglePhoto:
        true,

      title:
        title
          .substring(
            0,
            80
          )
          .trim() ||
        'Instagram Photo',

      photoUrl:
        imageUrl,

      ext,
    };
  } catch (
    err: unknown
  ) {
    const errorMsg =
      err instanceof Error
        ? err.message
        : String(err);

    console.error(
      '[INSTAGRAM HTML ERROR]:',
      errorMsg
    );

    return {
      isSinglePhoto:
        false,

      error:
        errorMsg,
    };
  }
}

/* =========================================================
   INSTAGRAM GALLERY-DL FALLBACK
   ========================================================= */

async function extractInstagramWithGalleryDl(
  targetUrl: string
): Promise<{
  isSinglePhoto: boolean;
  isVideoPost?: boolean;
  title?: string;
  photoUrl?: string;
  ext?: string;
  error?: string;
}> {
  try {
    console.log(
      `[INSTAGRAM GALLERY-DL] Fallback: ${targetUrl}`
    );

    const result =
      await runCommand(
        'gallery-dl',
        [
          '-j',
          '--no-download',
          targetUrl,
        ],
        25000
      );

    const lines =
      result.stdout
        .trim()
        .split('\n')
        .filter(
          (line) =>
            line.trim()
        );

    if (
      lines.length === 0
    ) {
      return {
        isSinglePhoto:
          false,

        error:
          'Output gallery-dl kosong.',
      };
    }

    const entries:
      unknown[] = [];

    for (
      const line of lines
    ) {
      try {
        entries.push(
          JSON.parse(
            line
          )
        );
      } catch {
        // Ignore non-JSON lines
      }
    }

    /*
     * gallery-dl:
     *
     * Message.Directory = 2
     * Message.Url       = 3
     *
     * Media URL ada di entry[1].
     */

    const mediaEntries =
      entries.filter(
        (entry) =>
          Array.isArray(
            entry
          ) &&
          entry.length >= 2 &&
          entry[0] === 3 &&
          typeof entry[1] ===
            'string'
      );

    console.log(
      `[gallery-dl] Total records: ${entries.length}, media URLs: ${mediaEntries.length}`
    );

    if (
      mediaEntries.length ===
      0
    ) {
      return {
        isSinglePhoto:
          false,

        error:
          'Tidak ditemukan URL media dalam output gallery-dl.',
      };
    }

    if (
      mediaEntries.length >
      1
    ) {
      return {
        isSinglePhoto:
          false,

        error:
          'Postingan carousel belum diaktifkan pada tahap ini.',
      };
    }

    const mediaEntry =
      mediaEntries[0];

    if (
      !Array.isArray(
        mediaEntry
      ) ||
      mediaEntry.length < 3
    ) {
      return {
        isSinglePhoto:
          false,

        error:
          'Format media gallery-dl tidak valid.',
      };
    }

    const directMediaUrl =
      typeof mediaEntry[1] ===
      'string'
        ? mediaEntry[1]
        : '';

    const metadata =
      typeof mediaEntry[2] ===
        'object' &&
      mediaEntry[2] !== null
        ? (mediaEntry[2] as Record<
            string,
            unknown
          >)
        : {};

    const typename =
      typeof metadata.typename ===
      'string'
        ? metadata.typename
        : '';

    if (
      typename ===
        'GraphVideo' ||
      /\.mp4(?:$|\?)/i.test(
        directMediaUrl
      )
    ) {
      return {
        isSinglePhoto:
          false,

        isVideoPost:
          true,
      };
    }

    if (
      !directMediaUrl.startsWith(
        'http://'
      ) &&
      !directMediaUrl.startsWith(
        'https://'
      )
    ) {
      return {
        isSinglePhoto:
          false,

        error:
          'URL gambar tidak valid.',
      };
    }

    try {
      const parsed =
        new URL(
          directMediaUrl
        );

      if (
        !isAllowedInstagramImageHost(
          parsed.hostname
        )
      ) {
        return {
          isSinglePhoto:
            false,

          error:
            'Host gambar tidak diizinkan.',
        };
      }
    } catch {
      return {
        isSinglePhoto:
          false,

        error:
          'URL gambar tidak valid.',
      };
    }

    const description =
      typeof metadata.description ===
      'string'
        ? metadata.description
        : typeof metadata.caption ===
          'string'
        ? metadata.caption
        : 'Instagram Photo';

    let extension =
      'jpg';

    if (
      typeof metadata.extension ===
      'string'
    ) {
      extension =
        metadata.extension;
    }

    return {
      isSinglePhoto:
        true,

      title:
        description
          .substring(
            0,
            80
          )
          .trim() ||
        'Instagram Photo',

      photoUrl:
        directMediaUrl,

      ext:
        extension
          .replace(
            /[^a-zA-Z0-9]/g,
            ''
          )
          .toLowerCase() ||
        'jpg',
    };
  } catch (
    err: unknown
  ) {
    const errorMsg =
      err instanceof Error
        ? err.message
        : String(err);

    console.error(
      '[gallery-dl Error]:',
      errorMsg
    );

    return {
      isSinglePhoto:
        false,

      error:
        errorMsg,
    };
  }
}

/* =========================================================
   INSTAGRAM PHOTO MASTER EXTRACTOR
   ========================================================= */

async function extractInstagramSinglePhoto(
  targetUrl: string
): Promise<{
  isSinglePhoto: boolean;
  isVideoPost?: boolean;
  title?: string;
  photoUrl?: string;
  ext?: string;
  error?: string;
}> {
  const htmlResult =
    await extractInstagramFromHtml(
      targetUrl
    );

  if (
    htmlResult.isSinglePhoto &&
    htmlResult.photoUrl
  ) {
    return htmlResult;
  }

  /*
   * Kalau HTML sudah mendeteksi video,
   * jangan lanjutkan sebagai foto.
   */

  if (
    htmlResult.isVideoPost
  ) {
    return htmlResult;
  }

  /*
   * Fallback gallery-dl.
   */

  const galleryResult =
    await extractInstagramWithGalleryDl(
      targetUrl
    );

  if (
    galleryResult.isSinglePhoto &&
    galleryResult.photoUrl
  ) {
    return galleryResult;
  }

  if (
    galleryResult.isVideoPost
  ) {
    return galleryResult;
  }

  return {
    isSinglePhoto:
      false,

    error:
      galleryResult.error ||
      htmlResult.error ||
      'Foto Instagram tidak dapat ditemukan.',
  };
}

/* =========================================================
   HEALTH
   ========================================================= */

app.get(
  '/api/health',
  (
    _req: Request,
    res: Response
  ): void => {
    res.json({
      status:
        'ok',

      service:
        'linkdrop-backend',

      time:
        new Date().toISOString(),

      activeDownloads:
        activeDownloadsCount,
    });
  }
);

/* =========================================================
   DEBUG INSTAGRAM
   ========================================================= */

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
        success:
          false,

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
        success:
          false,

        message:
          'URL Instagram publik diperlukan.',
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

      u.search =
        '';

      canonicalUrl =
        u.toString();
    } catch {
      canonicalUrl =
        rawUrl.trim();
    }

    const result =
      await extractInstagramSinglePhoto(
        canonicalUrl
      );

    res.json({
      success:
        true,

      url:
        canonicalUrl,

      extractor: {
        isSinglePhoto:
          result.isSinglePhoto,

        isVideoPost:
          result.isVideoPost ||
          false,

        title:
          result.title ||
          '',

        photoUrlFound:
          Boolean(
            result.photoUrl
          ),

        ext:
          result.ext ||
          '',

        error:
          result.error ||
          '',
      },
    });
  }
);

/* =========================================================
   DEBUG GALLERY
   ========================================================= */

app.get(
  '/api/debug-gallery',
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
        success:
          false,

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
        success:
          false,

        message:
          'URL Instagram publik diperlukan.',
      });

      return;
    }

    try {
      const result =
        await runCommand(
          'gallery-dl',
          [
            '-j',
            '--no-download',
            rawUrl,
          ],
          25000
        );

      res.json({
        success:
          true,

        command:
          'gallery-dl -j --no-download <URL>',

        exitCode:
          result.code,

        timedOut:
          false,

        stdout:
          result.stdout.substring(
            0,
            12000
          ),

        stderr:
          result.stderr.substring(
            0,
            6000
          ),
      });
    } catch (
      err: unknown
    ) {
      if (
        err instanceof
        CommandExecutionError
      ) {
        res.json({
          success:
            false,

          command:
            'gallery-dl -j --no-download <URL>',

          exitCode:
            err.code,

          timedOut:
            err.timedOut,

          stdout:
            err.stdout.substring(
              0,
              12000
            ),

          stderr:
            err.stderr.substring(
              0,
              6000
            ),

          message:
            err.message,
        });

        return;
      }

      const message =
        err instanceof Error
          ? err.message
          : String(err);

      res.status(500).json({
        success:
          false,

        message,
      });
    }
  }
);

/* =========================================================
   ANALYZE
   ========================================================= */

app.post(
  '/api/analyze',
  async (
    req: Request,
    res: Response
  ): Promise<void> => {
    const {
      url,
    } = req.body;

    if (
      !url ||
      typeof url !==
        'string'
    ) {
      res.status(400).json({
        success:
          false,

        message:
          'URL publik yang didukung diperlukan.',
      });

      return;
    }

    const safety =
      await validateUrlSafety(
        url
      );

    if (
      !safety.safe
    ) {
      res.status(400).json({
        success:
          false,

        message:
          safety.error ||
          'Link tidak dapat diproses.',
      });

      return;
    }

    /* =====================================================
       INSTAGRAM POST
       ===================================================== */

    if (
      safety.platform ===
        'instagram' &&
      url.includes('/p/')
    ) {
      console.log(
        `[ANALYZE] Instagram post: ${url}`
      );

      const photoResult =
        await extractInstagramSinglePhoto(
          url
        );

      /* Single Photo */

      if (
        photoResult.isSinglePhoto &&
        photoResult.photoUrl
      ) {
        res.json({
          success:
            true,

          platform:
            'instagram',

          type:
            'image',

          title:
            photoResult.title ||
            'Foto Instagram',

          thumbnail:
            photoResult.photoUrl,

          uploader:
            'Instagram User',

          items: [
            {
              index:
                0,

              type:
                'image',

              url:
                photoResult.photoUrl,

              ext:
                photoResult.ext ||
                'jpg',
            },
          ],

          url,
        });

        return;
      }

      /* Carousel */

      if (
        photoResult.error &&
        photoResult.error.includes(
          'carousel'
        )
      ) {
        res.status(400).json({
          success:
            false,

          message:
            'Dukungan untuk Instagram Carousel sedang dalam pengembangan.',
        });

        return;
      }

      /* Video */

      if (
        photoResult.isVideoPost
      ) {
        console.log(
          '[ANALYZE] Instagram post adalah video. Lanjut yt-dlp.'
        );
      } else {
        console.log(
          '[ANALYZE] Instagram photo extractor gagal, mencoba yt-dlp.'
        );
      }
    }

    /* =====================================================
       VIDEO PIPELINE
       ===================================================== */

    try {
      console.log(
        `[ANALYZE] Menjalankan yt-dlp: ${url}`
      );

      const args = [
        '--dump-json',
        '--no-playlist',
        '--skip-download',
        '--no-warnings',
        '--no-check-certificates',
        url,
      ];

      const result =
        await runCommand(
          'yt-dlp',
          args,
          25000
        );

      const meta =
        JSON.parse(
          result.stdout
        );

      const formats = [
        {
          id:
            'best',

          label:
            'Video MP4 (HD)',

          extension:
            'mp4',

          quality:
            'HD',

          type:
            'video',
        },

        {
          id:
            'audio',

          label:
            'Audio MP3',

          extension:
            'mp3',

          quality:
            'High Audio',

          type:
            'audio',
        },
      ];

      res.json({
        success:
          true,

        platform:
          safety.platform,

        type:
          'video',

        title:
          meta.title ||
          'LinkDrop Video',

        thumbnail:
          meta.thumbnail ||
          '',

        uploader:
          meta.uploader ||
          meta.channel ||
          'Publik',

        duration:
          meta.duration ||
          0,

        url,

        formats,
      });
    } catch (
      err: unknown
    ) {
      const errorMsg =
        err instanceof Error
          ? err.message
          : String(err);

      console.error(
        '[Analyze Error]:',
        errorMsg
      );

      const lower =
        errorMsg.toLowerCase();

      if (
        safety.platform ===
        'instagram'
      ) {
        res.status(400).json({
          success:
            false,

          message:
            'Foto/video Instagram ini tidak dapat diproses saat ini.',
        });

        return;
      }

      if (
        lower.includes(
          'private'
        ) ||
        lower.includes(
          'login'
        )
      ) {
        res.status(400).json({
          success:
            false,

          message:
            'Media ini tidak dapat diakses karena bersifat privat atau membutuhkan login.',
        });

        return;
      }

      res.status(500).json({
        success:
          false,

        message:
          'Media tidak tersedia atau tidak dapat diproses saat ini.',
      });
    }
  }
);

/* =========================================================
   DOWNLOAD VIDEO / AUDIO
   ========================================================= */

app.post(
  '/api/download',
  async (
    req: Request,
    res: Response
  ): Promise<void> => {
    const {
      url,
      formatId,
    } = req.body;

    if (
      !url ||
      typeof url !==
        'string'
    ) {
      res.status(400).json({
        success:
          false,

        message:
          'URL publik yang didukung diperlukan.',
      });

      return;
    }

    const safety =
      await validateUrlSafety(
        url
      );

    if (
      !safety.safe
    ) {
      res.status(400).json({
        success:
          false,

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
        success:
          false,

        message:
          'Server sibuk. Coba beberapa saat lagi.',
      });

      return;
    }

    activeDownloadsCount++;

    const isAudio =
      formatId ===
      'audio';

    const ext =
      isAudio
        ? 'mp3'
        : 'mp4';

    const jobId =
      crypto
        .randomBytes(8)
        .toString('hex');

    const tempOutputTemplate =
      path.join(
        TEMP_DIR,
        `${jobId}.%(ext)s`
      );

    let finalFilePath =
      '';

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

      if (
        isAudio
      ) {
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

      args.push(
        url
      );

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
        files.find(
          (
            file
          ) =>
            file.startsWith(
              jobId
            )
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

      const filename =
        sanitizeFilename(
          `LinkDrop_${
            safety.platform ||
            'Media'
          }`,
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
        `attachment; filename="${filename}"`
      );

      res.setHeader(
        'Content-Length',
        stats.size
      );

      const stream =
        fs.createReadStream(
          finalFilePath
        );

      stream.pipe(
        res
      );

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
          } catch {
            // ignore
          }
        };

      res.on(
        'finish',
        cleanup
      );

      res.on(
        'close',
        cleanup
      );
    } catch (
      err: unknown
    ) {
      const errorMsg =
        err instanceof Error
          ? err.message
          : String(err);

      console.error(
        '[Download Error]:',
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
        } catch {
          // ignore
        }
      }

      if (
        !res.headersSent
      ) {
        res.status(500).json({
          success:
            false,

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

/* =========================================================
   DOWNLOAD INSTAGRAM IMAGE
   ========================================================= */

app.post(
  '/api/download-image',
  async (
    req: Request,
    res: Response
  ): Promise<void> => {
    const {
      url,
      imageUrl,
    } = req.body;

    let targetImageUrl =
      '';

    /* -----------------------------------------------------
       Re-extract dari URL Instagram asli
       ----------------------------------------------------- */

    if (
      url &&
      typeof url ===
        'string'
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
    }

    /* -----------------------------------------------------
       Fallback imageUrl dari frontend
       ----------------------------------------------------- */

    if (
      !targetImageUrl &&
      imageUrl &&
      typeof imageUrl ===
        'string'
    ) {
      try {
        const parsed =
          new URL(
            imageUrl
          );

        if (
          isAllowedInstagramImageHost(
            parsed.hostname
          )
        ) {
          targetImageUrl =
            imageUrl;
        } else {
          console.warn(
            `[Security] Image host ditolak: ${parsed.hostname}`
          );
        }
      } catch {
        // ignore
      }
    }

    if (
      !targetImageUrl
    ) {
      res.status(400).json({
        success:
          false,

        message:
          'Foto Instagram ini tidak dapat diproses saat ini.',
      });

      return;
    }

    /* -----------------------------------------------------
       Download image
       ----------------------------------------------------- */

    try {
      console.log(
        '[Download Image] Mengunduh gambar...'
      );

      const parsed =
        new URL(
          targetImageUrl
        );

      if (
        !isAllowedInstagramImageHost(
          parsed.hostname
        )
      ) {
        res.status(400).json({
          success:
            false,

          message:
            'Host gambar tidak diizinkan.',
        });

        return;
      }

      const controller =
        new AbortController();

      const timeout =
        setTimeout(
          () =>
            controller.abort(),
          30000
        );

      const imgResponse =
        await fetch(
          targetImageUrl,
          {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',

              Accept:
                'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            },

            signal:
              controller.signal,
          }
        );

      clearTimeout(
        timeout
      );

      if (
        !imgResponse.ok
      ) {
        throw new Error(
          `Gagal mengambil media (${imgResponse.status})`
        );
      }

      const contentType =
        imgResponse.headers.get(
          'content-type'
        ) || '';

      if (
        !contentType.startsWith(
          'image/'
        )
      ) {
        throw new Error(
          'Response bukan file gambar.'
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
          success:
            false,

          message:
            'File terlalu besar untuk diproses.',
        });

        return;
      }

      let ext =
        'jpg';

      if (
        contentType.includes(
          'png'
        )
      ) {
        ext =
          'png';
      } else if (
        contentType.includes(
          'webp'
        )
      ) {
        ext =
          'webp';
      } else if (
        contentType.includes(
          'jpeg'
        )
      ) {
        ext =
          'jpg';
      }

      const filename =
        sanitizeFilename(
          'LinkDrop_Instagram_Photo',
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

      res.send(
        buffer
      );
    } catch (
      err: unknown
    ) {
      const errorMsg =
        err instanceof Error
          ? err.message
          : String(err);

      console.error(
        '[Download Image Error]:',
        errorMsg
      );

      if (
        !res.headersSent
      ) {
        res.status(500).json({
          success:
            false,

          message:
            'Foto Instagram ini tidak dapat diproses saat ini.',
        });
      }
    }
  }
);

/* =========================================================
   TEMP FILE CLEANUP
   ========================================================= */

setInterval(
  () => {
    try {
      const now =
        Date.now();

      const files =
        fs.readdirSync(
          TEMP_DIR
        );

      for (
        const file of files
      ) {
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
          now -
            stat.mtimeMs >
          15 *
            60 *
            1000
        ) {
          fs.unlinkSync(
            fullPath
          );
        }
      }
    } catch {
      // ignore
    }
  },
  10 *
    60 *
    1000
);

/* =========================================================
   START SERVER
   ========================================================= */

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `[LinkDrop Server] Aktif di port ${PORT}`
    );

    console.log(
      `[LinkDrop Server] Temp directory: ${TEMP_DIR}`
    );
  }
);
