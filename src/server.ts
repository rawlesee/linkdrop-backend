/**
 * LinkDrop Production Server
 * Instagram Media Extraction + Playwright Edition
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
import { chromium } from 'playwright-core';

const app = express();

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

const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ||
  '/usr/bin/chromium';

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, {
    recursive: true,
  });
}

/* =========================================================
   MIDDLEWARE
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
   INSTAGRAM MEDIA HOST VALIDATION
   ========================================================= */

function isAllowedInstagramMediaHost(
  hostname: string
): boolean {
  const host = hostname.toLowerCase();

  if (
    host === 'static.cdninstagram.com' ||
    host.endsWith('.static.cdninstagram.com')
  ) {
    return false;
  }

  if (
    host === 'cdninstagram.com' ||
    host.endsWith('.cdninstagram.com')
  ) {
    return (
      host.startsWith('scontent') ||
      host.includes('scontent-')
    );
  }

  if (
    host === 'fbcdn.net' ||
    host.endsWith('.fbcdn.net')
  ) {
    return true;
  }

  return false;
}

/* =========================================================
   URL SAFETY
   ========================================================= */

async function validateUrlSafety(
  inputUrl: string
): Promise<{
  safe: boolean;
  platform?: string;
  error?: string;
}> {
  try {
    const parsed = new URL(inputUrl);

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
      | string
      | undefined;

    for (
      const [
        platform,
        regex,
      ] of Object.entries(
        SUPPORTED_DOMAINS
      )
    ) {
      if (regex.test(hostname)) {
        matchedPlatform = platform;
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

    for (
      const addr of addresses
    ) {
      const ip = addr.address;

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
      platform: matchedPlatform,
    };
  } catch {
    return {
      safe: false,
      error: 'Link tidak valid.',
    };
  }
}

/* =========================================================
   COMMAND EXECUTION
   ========================================================= */

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

class CommandExecutionError extends Error {
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

function runCommand(
  command: string,
  args: string[],
  timeoutMs = 30000
): Promise<CommandResult> {
  return new Promise(
    (resolve, reject) => {
      console.log(
        `[EXEC] ${command} ${args.join(' ')}`
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
      let settled = false;

      const timer =
        setTimeout(
          () => {
            if (settled) {
              return;
            }

            settled = true;

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
          stdout += chunk.toString();
        }
      );

      child.stderr?.on(
        'data',
        (
          chunk:
            | Buffer
            | string
        ) => {
          stderr += chunk.toString();
        }
      );

      child.on(
        'error',
        (
          err: Error
        ) => {
          if (settled) {
            return;
          }

          clearTimeout(timer);
          settled = true;

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
          code
        ) => {
          if (settled) {
            return;
          }

          clearTimeout(timer);
          settled = true;

          const exitCode =
            code ?? 1;

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
                  `Command failed with exit code ${exitCode}`,
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
   FETCH INSTAGRAM HTML
   ========================================================= */

async function fetchInstagramHtml(
  targetUrl: string
): Promise<{
  status: number;
  finalUrl: string;
  contentType: string;
  html: string;
}> {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      20000
    );

  try {
    const response =
      await fetch(
        targetUrl,
        {
          method: 'GET',
          redirect: 'follow',

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

    const html =
      await response.text();

    return {
      status:
        response.status,

      finalUrl:
        response.url,

      contentType:
        response.headers.get(
          'content-type'
        ) || '',

      html,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/* =========================================================
   HTML ENTITY / JSON DECODING
   ========================================================= */

function decodeHtmlEntities(
  value: string
): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function decodeInstagramUrl(
  value: string
): string {
  let result = value;

  result =
    result
      .replace(
        /\\u0026/gi,
        '&'
      )
      .replace(
        /\\u003D/gi,
        '='
      )
      .replace(
        /\\u002F/gi,
        '/'
      )
      .replace(
        /\\u002f/gi,
        '/'
      )
      .replace(
        /\\\//g,
        '/'
      )
      .replace(
        /&amp;/gi,
        '&'
      );

  try {
    result =
      JSON.parse(
        `"${result.replace(
          /"/g,
          '\\"'
        )}"`
      );
  } catch {
    // keep decoded result
  }

  return result;
}

/* =========================================================
   META TAG PARSER
   ========================================================= */

function getMetaContent(
  html: string,
  property: string
): string {
  const metaTags =
    html.match(
      /<meta\b[^>]*>/gi
    ) || [];

  for (
    const tag of metaTags
  ) {
    const propertyMatch =
      tag.match(
        /\bproperty\s*=\s*["']([^"']+)["']/i
      );

    const nameMatch =
      tag.match(
        /\bname\s*=\s*["']([^"']+)["']/i
      );

    const contentMatch =
      tag.match(
        /\bcontent\s*=\s*["']([^"']*)["']/i
      );

    if (!contentMatch) {
      continue;
    }

    const propertyValue =
      propertyMatch?.[1]
        ?.toLowerCase();

    const nameValue =
      nameMatch?.[1]
        ?.toLowerCase();

    if (
      propertyValue ===
        property.toLowerCase() ||
      nameValue ===
        property.toLowerCase()
    ) {
      return decodeHtmlEntities(
        contentMatch[1]
      );
    }
  }

  return '';
}

/* =========================================================
   INSTAGRAM MEDIA URL VALIDATION
   ========================================================= */

function validateInstagramMediaUrl(
  rawUrl: string
): string | null {
  let value =
    decodeInstagramUrl(
      rawUrl
    ).trim();

  value =
    value.replace(
      /["'<>\\]+$/g,
      ''
    );

  try {
    const parsed =
      new URL(value);

    if (
      !isAllowedInstagramMediaHost(
        parsed.hostname
      )
    ) {
      return null;
    }

    const pathname =
      parsed.pathname.toLowerCase();

    if (
      pathname.endsWith('.css') ||
      pathname.endsWith('.js') ||
      pathname.endsWith('.ico') ||
      pathname.includes('/rsrc.php/')
    ) {
      return null;
    }

    const looksLikeMedia =
      pathname.includes('/v/t51') ||
      pathname.includes('/t51.') ||
      pathname.includes('.jpg') ||
      pathname.includes('.jpeg') ||
      pathname.includes('.png') ||
      pathname.includes('.webp') ||
      parsed.searchParams.has('stp');

    if (!looksLikeMedia) {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

/* =========================================================
   EXTRACT URL FROM JSON FIELD
   ========================================================= */

function extractUrlsFromField(
  html: string,
  fieldName: string
): string[] {
  const results =
    new Set<string>();

  const pattern =
    new RegExp(
      `"${fieldName}"\\s*:\\s*"([^"]+)"`,
      'gi'
    );

  let match:
    | RegExpExecArray
    | null;

  while (
    (match =
      pattern.exec(html)) !== null
  ) {
    const url =
      validateInstagramMediaUrl(
        match[1]
      );

    if (url) {
      results.add(url);
    }
  }

  return Array.from(results);
}

/* =========================================================
   EXTRACT IMAGE CANDIDATES
   ========================================================= */

interface InstagramImageCandidate {
  url: string;
  score: number;
  reason: string;
}

function collectInstagramImageCandidates(
  html: string
): InstagramImageCandidate[] {
  const candidates =
    new Map<
      string,
      InstagramImageCandidate
    >();

  function addCandidate(
    url: string,
    score: number,
    reason: string
  ) {
    const existing =
      candidates.get(url);

    if (
      !existing ||
      score > existing.score
    ) {
      candidates.set(
        url,
        {
          url,
          score,
          reason,
        }
      );
    }
  }

  const displayUrls =
    extractUrlsFromField(
      html,
      'display_url'
    );

  for (
    const url of displayUrls
  ) {
    addCandidate(
      url,
      100,
      'display_url'
    );
  }

  const thumbnailUrls =
    extractUrlsFromField(
      html,
      'thumbnail_src'
    );

  for (
    const url of thumbnailUrls
  ) {
    addCandidate(
      url,
      90,
      'thumbnail_src'
    );
  }

  const imageVersionUrls =
    extractUrlsFromField(
      html,
      'url'
    );

  for (
    const url of imageVersionUrls
  ) {
    addCandidate(
      url,
      70,
      'image_versions2/url'
    );
  }

  const absoluteUrlRegex =
    /https?:\/\/[^"'<>\\\s]+/gi;

  const absoluteMatches =
    html.match(
      absoluteUrlRegex
    ) || [];

  for (
    let raw of absoluteMatches
  ) {
    raw =
      raw.replace(
        /[,}\])]+$/g,
        ''
      );

    const url =
      validateInstagramMediaUrl(
        raw
      );

    if (!url) {
      continue;
    }

    let score = 50;

    const lower =
      url.toLowerCase();

    if (
      lower.includes('/v/t51')
    ) {
      score += 30;
    }

    if (
      lower.includes('scontent')
    ) {
      score += 20;
    }

    if (
      lower.includes('stp=')
    ) {
      score += 10;
    }

    addCandidate(
      url,
      score,
      'Instagram CDN URL'
    );
  }

  const escapedUrlRegex =
    /https?:\\\/\\\/[^"'<>\\\s]+/gi;

  const escapedMatches =
    html.match(
      escapedUrlRegex
    ) || [];

  for (
    let raw of escapedMatches
  ) {
    raw =
      decodeInstagramUrl(
        raw
      );

    raw =
      raw.replace(
        /[,}\])]+$/g,
        ''
      );

    const url =
      validateInstagramMediaUrl(
        raw
      );

    if (!url) {
      continue;
    }

    let score = 60;

    const lower =
      url.toLowerCase();

    if (
      lower.includes('/v/t51')
    ) {
      score += 30;
    }

    if (
      lower.includes('scontent')
    ) {
      score += 20;
    }

    addCandidate(
      url,
      score,
      'Escaped Instagram CDN URL'
    );
  }

  return Array.from(
    candidates.values()
  ).sort(
    (
      a,
      b
    ) =>
      b.score - a.score
  );
}

/* =========================================================
   PLAYWRIGHT INSTAGRAM EXTRACTION
   ========================================================= */

interface BrowserInstagramImage {
  url: string;
  width: number;
  height: number;
  source: string;
}

interface BrowserInstagramResult {
  success: boolean;

  type:
    | 'image'
    | 'video'
    | 'unknown';

  title: string;

  images: BrowserInstagramImage[];

  videoUrl: string;

  finalUrl: string;

  pageTitle: string;

  error?: string;
}

async function extractInstagramWithPlaywright(
  targetUrl: string
): Promise<BrowserInstagramResult> {
  let browser:
    Awaited<
      ReturnType<typeof chromium.launch>
    > | null = null;

  try {
    console.log(
      `[Instagram Playwright] Launching Chromium: ${CHROMIUM_PATH}`
    );

    browser =
      await chromium.launch({
        headless: true,

        executablePath:
          CHROMIUM_PATH,

        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-blink-features=AutomationControlled',
        ],
      });

    const context =
      await browser.newContext({
        viewport: {
          width: 1365,
          height: 900,
        },

        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',

        locale:
          'en-US',

        timezoneId:
          'Asia/Jakarta',

        colorScheme:
          'light',

        extraHTTPHeaders: {
          'Accept-Language':
            'en-US,en;q=0.9',
        },
      });

    const page =
      await context.newPage();

    await page.goto(
      targetUrl,
      {
        waitUntil:
          'domcontentloaded',

        timeout: 30000,
      }
    );

    /*
     * Give Instagram's client-side
     * rendering a little time.
     */

    await page.waitForTimeout(
      4000
    );

    /*
     * Try waiting for images.
     */

    try {
      await page.waitForLoadState(
        'networkidle',
        {
          timeout: 8000,
        }
      );
    } catch {
      // networkidle may never happen
    }

    const finalUrl =
      page.url();

    const pageTitle =
      await page.title().catch(
        () => ''
      );

    /*
     * Detect login redirect.
     */

    if (
      finalUrl.includes(
        '/accounts/login'
      )
    ) {
      await browser.close();
      browser = null;

      return {
        success: false,

        type:
          'unknown',

        title: '',

        images: [],

        videoUrl: '',

        finalUrl,

        pageTitle,

        error:
          'Instagram mengarahkan halaman ke login.',
      };
    }

    /*
     * Extract images from the rendered DOM.
     *
     * We deliberately only accept URLs from
     * Instagram/Facebook media CDNs.
     */

    const domImages =
      await page.evaluate(
        () => {
          const output: Array<{
            url: string;
            width: number;
            height: number;
            source: string;
          }> = [];

          const images =
            Array.from(
              document.querySelectorAll(
                'img'
              )
            );

          for (
            const img of images
          ) {
            const element =
              img as HTMLImageElement;

            const url =
              element.currentSrc ||
              element.src ||
              '';

            if (!url) {
              continue;
            }

            output.push({
              url,

              width:
                element.naturalWidth ||
                element.width ||
                0,

              height:
                element.naturalHeight ||
                element.height ||
                0,

              source:
                'dom-img',
            });

            /*
             * Also inspect srcset because
             * Instagram can keep the larger
             * version there.
             */

            const srcset =
              element.srcset ||
              '';

            if (srcset) {
              const parts =
                srcset
                  .split(',')
                  .map(
                    (
                      item
                    ) =>
                      item
                        .trim()
                        .split(
                          /\s+/
                        )[0]
                  )
                  .filter(
                    Boolean
                  );

              for (
                const src of parts
              ) {
                output.push({
                  url: src,

                  width:
                    element.naturalWidth ||
                    element.width ||
                    0,

                  height:
                    element.naturalHeight ||
                    element.height ||
                    0,

                  source:
                    'dom-srcset',
                });
              }
            }
          }

          return output;
        }
      );

    /*
     * Also inspect browser network resource
     * URLs. This is useful when the image is
     * rendered by React but not exposed in
     * the original HTML.
     */

    const networkImages =
      await page.evaluate(
        () => {
          const entries =
            performance.getEntriesByType(
              'resource'
            );

          return entries
            .map(
              (
                entry
              ) =>
                (
                  entry as PerformanceResourceTiming
                ).name
            )
            .filter(
              Boolean
            );
        }
      );

    /*
     * Extract video sources too.
     */

    const browserVideos =
      await page.evaluate(
        () => {
          const urls =
            new Set<string>();

          const videos =
            Array.from(
              document.querySelectorAll(
                'video'
              )
            );

          for (
            const video of videos
          ) {
            const element =
              video as HTMLVideoElement;

            if (
              element.currentSrc
            ) {
              urls.add(
                element.currentSrc
              );
            }

            if (
              element.src
            ) {
              urls.add(
                element.src
              );
            }

            const sources =
              Array.from(
                element.querySelectorAll(
                  'source'
                )
              );

            for (
              const source of sources
            ) {
              const src =
                source.getAttribute(
                  'src'
                );

              if (src) {
                urls.add(src);
              }
            }
          }

          return Array.from(
            urls
          );
        }
      );

    /*
     * Combine DOM and network URLs.
     */

    const rawCandidates =
      [
        ...domImages,
        ...networkImages.map(
          (
            url
          ) => ({
            url,
            width: 0,
            height: 0,
            source:
              'performance-resource',
          })
        ),
      ];

    const imageMap =
      new Map<
        string,
        BrowserInstagramImage
      >();

    for (
      const candidate of rawCandidates
    ) {
      const validated =
        validateInstagramMediaUrl(
          candidate.url
        );

      if (!validated) {
        continue;
      }

      /*
       * Ignore tiny images. Profile pictures
       * and icons are generally much smaller.
       */

      if (
        candidate.width > 0 &&
        candidate.height > 0 &&
        (
          candidate.width < 250 ||
          candidate.height < 250
        )
      ) {
        continue;
      }

      const existing =
        imageMap.get(
          validated
        );

      if (
        !existing ||
        (
          candidate.width *
            candidate.height >
          existing.width *
            existing.height
        )
      ) {
        imageMap.set(
          validated,
          {
            url: validated,

            width:
              candidate.width,

            height:
              candidate.height,

            source:
              candidate.source,
          }
        );
      }
    }

    /*
     * Sort largest images first.
     */

    const images =
      Array.from(
        imageMap.values()
      ).sort(
        (
          a,
          b
        ) =>
          (
            b.width *
            b.height
          ) -
          (
            a.width *
            a.height
          )
      );

    /*
     * Validate browser video URLs.
     *
     * We don't use these directly for
     * image downloading.
     */

    let videoUrl = '';

    for (
      const rawVideo of browserVideos
    ) {
      try {
        const parsed =
          new URL(
            rawVideo
          );

        const host =
          parsed.hostname.toLowerCase();

        if (
          host.includes(
            'cdninstagram'
          ) ||
          host.endsWith(
            'fbcdn.net'
          )
        ) {
          videoUrl =
            rawVideo;

          break;
        }
      } catch {
        // ignore
      }
    }

    /*
     * Determine media type.
     */

    const bodyText =
      await page.locator(
        'body'
      ).innerText().catch(
        () => ''
      );

    const looksLikeVideo =
      Boolean(
        videoUrl
      ) ||
      /watch the full video|video/i.test(
        bodyText
      );

    const type =
      images.length > 0
        ? 'image'
        : looksLikeVideo
          ? 'video'
          : 'unknown';

    const title =
      pageTitle ||
      (
        type === 'image'
          ? 'Instagram Photo'
          : type === 'video'
            ? 'Instagram Video'
            : ''
      );

    console.log(
      `[Instagram Playwright] type=${type}, images=${images.length}, video=${Boolean(videoUrl)}`
    );

    await browser.close();
    browser = null;

    return {
      success:
        type !== 'unknown',

      type,

      title,

      images,

      videoUrl,

      finalUrl,

      pageTitle,
    };
  } catch (
    err: unknown
  ) {
    console.error(
      '[Instagram Playwright Error]',
      err
    );

    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }

    return {
      success: false,

      type:
        'unknown',

      title: '',

      images: [],

      videoUrl: '',

      finalUrl: targetUrl,

      pageTitle: '',

      error:
        err instanceof Error
          ? err.message
          : String(err),
    };
  }
}

/* =========================================================
   EXTRACT INSTAGRAM HTML MEDIA
   ========================================================= */

async function extractInstagramFromHtml(
  targetUrl: string
): Promise<{
  type:
    | 'image'
    | 'video'
    | 'unknown';

  title: string;

  imageUrl?: string;

  thumbnail?: string;

  ext?: string;

  debug?: {
    candidateCount: number;
    candidates: InstagramImageCandidate[];
  };
}> {
  const result =
    await fetchInstagramHtml(
      targetUrl
    );

  const html =
    result.html;

  if (
    result.status < 200 ||
    result.status >= 300
  ) {
    return {
      type: 'unknown',
      title: '',
    };
  }

  if (
    result.finalUrl.includes(
      '/accounts/login'
    )
  ) {
    return {
      type: 'unknown',
      title: '',
    };
  }

  const ogTitle =
    getMetaContent(
      html,
      'og:title'
    );

  const ogImage =
    getMetaContent(
      html,
      'og:image'
    );

  const ogVideo =
    getMetaContent(
      html,
      'og:video'
    );

  const hasVideo =
    Boolean(ogVideo) ||
    /"is_video"\s*:\s*true/i.test(
      html
    ) ||
    /"video_versions"/i.test(
      html
    ) ||
    /"video_url"/i.test(
      html
    );

  const candidates =
    collectInstagramImageCandidates(
      html
    );

  if (hasVideo) {
    let thumbnail = '';

    const validatedOgImage =
      ogImage
        ? validateInstagramMediaUrl(
            ogImage
          )
        : null;

    if (validatedOgImage) {
      thumbnail =
        validatedOgImage;
    } else if (
      candidates.length > 0
    ) {
      thumbnail =
        candidates[0].url;
    }

    return {
      type: 'video',

      title:
        ogTitle ||
        'Instagram Video',

      thumbnail,
    };
  }

  if (
    candidates.length > 0
  ) {
    const best =
      candidates[0];

    return {
      type: 'image',

      title:
        ogTitle ||
        'Instagram Photo',

      imageUrl:
        best.url,

      thumbnail:
        best.url,

      ext: 'jpg',

      debug: {
        candidateCount:
          candidates.length,

        candidates:
          candidates.slice(
            0,
            10
          ),
      },
    };
  }

  return {
    type: 'unknown',

    title: '',

    debug: {
      candidateCount: 0,
      candidates: [],
    },
  };
}

/* =========================================================
   GALLERY-DL FALLBACK
   ========================================================= */

async function extractInstagramWithGalleryDl(
  targetUrl: string
): Promise<{
  type:
    | 'image'
    | 'unknown';

  title: string;

  imageUrl?: string;

  ext?: string;
}> {
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

  const raw =
    result.stdout.trim();

  if (!raw) {
    return {
      type: 'unknown',
      title: '',
    };
  }

  let parsedOutput:
    unknown;

  try {
    parsedOutput =
      JSON.parse(
        raw
      );
  } catch {
    const entries:
      unknown[] = [];

    const lines =
      raw
        .split('\n')
        .filter(
          (
            line
          ) =>
            line.trim()
        );

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
        // ignore
      }
    }

    parsedOutput =
      entries;
  }

  const entries:
    unknown[] = [];

  if (
    Array.isArray(
      parsedOutput
    )
  ) {
    for (
      const item of parsedOutput
    ) {
      if (
        Array.isArray(
          item
        )
      ) {
        entries.push(
          item
        );
      }
    }
  }

  type GalleryUrlEntry =
    [
      number,
      string,
      Record<
        string,
        unknown
      >?
    ];

  const mediaEntries =
    entries.filter(
      (
        entry
      ): entry is GalleryUrlEntry =>
        Array.isArray(
          entry
        ) &&
        entry.length >= 2 &&
        entry[0] === 3 &&
        typeof entry[1] ===
          'string'
    );

  if (
    mediaEntries.length === 1
  ) {
    const media =
      mediaEntries[0];

    const mediaUrl =
      validateInstagramMediaUrl(
        media[1]
      );

    if (mediaUrl) {
      return {
        type: 'image',

        title:
          'Instagram Photo',

        imageUrl:
          mediaUrl,

        ext: 'jpg',
      };
    }
  }

  return {
    type: 'unknown',
    title: '',
  };
}

/* =========================================================
   INSTAGRAM ANALYZER
   ========================================================= */

interface InstagramAnalyzeResult {
  type:
    | 'image'
    | 'video'
    | 'unknown';

  title?: string;

  thumbnail?: string;

  imageUrl?: string;

  ext?: string;

  items?: Array<{
    index: number;
    type: 'image';
    url: string;
    ext: string;
  }>;

  debug?: Record<
    string,
    unknown
  >;
}

async function analyzeInstagram(
  targetUrl: string
): Promise<InstagramAnalyzeResult> {
  /*
   * STEP 1
   * Try normal HTML first.
   */

  try {
    const htmlResult =
      await extractInstagramFromHtml(
        targetUrl
      );

    if (
      htmlResult.type !==
      'unknown'
    ) {
      return {
        type:
          htmlResult.type,

        title:
          htmlResult.title,

        thumbnail:
          htmlResult.thumbnail,

        imageUrl:
          htmlResult.imageUrl,

        ext:
          htmlResult.ext,
      };
    }
  } catch (
    err: unknown
  ) {
    console.error(
      '[Instagram HTML]',
      err
    );
  }

  /*
   * STEP 2
   * Playwright.
   *
   * This is the important new part.
   */

  try {
    const browserResult =
      await extractInstagramWithPlaywright(
        targetUrl
      );

    if (
      browserResult.type ===
      'image' &&
      browserResult.images.length >
        0
    ) {
      const items =
        browserResult.images.map(
          (
            image,
            index
          ) => ({
            index,

            type:
              'image' as const,

            url:
              image.url,

            ext:
              'jpg',
          })
        );

      return {
        type: 'image',

        title:
          browserResult.title ||
          'Instagram Photo',

        thumbnail:
          items[0]?.url ||
          '',

        imageUrl:
          items[0]?.url ||
          '',

        ext: 'jpg',

        items,

        debug: {
          source:
            'playwright',

          finalUrl:
            browserResult.finalUrl,

          imageCount:
            browserResult.images.length,

          images:
            browserResult.images
              .slice(
                0,
                20
              ),
        },
      };
    }

    /*
     * If Playwright found a video,
     * let yt-dlp handle the actual
     * video download.
     */

    if (
      browserResult.type ===
      'video'
    ) {
      return {
        type: 'video',

        title:
          browserResult.title ||
          'Instagram Video',
      };
    }
  } catch (
    err: unknown
  ) {
    console.error(
      '[Instagram Playwright]',
      err
    );
  }

  /*
   * STEP 3
   * gallery-dl fallback.
   */

  try {
    const galleryResult =
      await extractInstagramWithGalleryDl(
        targetUrl
      );

    if (
      galleryResult.type ===
      'image'
    ) {
      return {
        type: 'image',

        title:
          galleryResult.title,

        imageUrl:
          galleryResult.imageUrl,

        thumbnail:
          galleryResult.imageUrl,

        ext:
          galleryResult.ext ||
          'jpg',

        items:
          galleryResult.imageUrl
            ? [
                {
                  index: 0,

                  type:
                    'image',

                  url:
                    galleryResult.imageUrl,

                  ext:
                    galleryResult.ext ||
                    'jpg',
                },
              ]
            : [],
      };
    }
  } catch (
    err: unknown
  ) {
    console.error(
      '[Instagram gallery-dl]',
      err
    );
  }

  return {
    type: 'unknown',
  };
}

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
          'URL Instagram publik diperlukan.',
      });

      return;
    }

    let canonicalUrl =
      rawUrl.trim();

    try {
      const parsed =
        new URL(
          canonicalUrl
        );

      parsed.search = '';

      canonicalUrl =
        parsed.toString();
    } catch {
      // keep original
    }

    /* ---------------------------------------------
       HTML TEST
       --------------------------------------------- */

    let htmlTest:
      Record<
        string,
        unknown
      >;

    try {
      const result =
        await fetchInstagramHtml(
          canonicalUrl
        );

      const html =
        result.html;

      const ogImage =
        getMetaContent(
          html,
          'og:image'
        );

      const ogTitle =
        getMetaContent(
          html,
          'og:title'
        );

      const ogDescription =
        getMetaContent(
          html,
          'og:description'
        );

      const ogVideo =
        getMetaContent(
          html,
          'og:video'
        );

      const candidates =
        collectInstagramImageCandidates(
          html
        );

      const mediaFieldCounts = {
        display_url:
          extractUrlsFromField(
            html,
            'display_url'
          ).length,

        thumbnail_src:
          extractUrlsFromField(
            html,
            'thumbnail_src'
          ).length,

        image_versions2_url:
          extractUrlsFromField(
            html,
            'url'
          ).length,
      };

      const ogImageIndex =
        html
          .toLowerCase()
          .indexOf(
            'og:image'
          );

      let ogImageSnippet =
        '';

      if (
        ogImageIndex >= 0
      ) {
        const start =
          Math.max(
            0,
            ogImageIndex - 500
          );

        const end =
          Math.min(
            html.length,
            ogImageIndex + 1500
          );

        ogImageSnippet =
          html.substring(
            start,
            end
          );
      }

      htmlTest = {
        status:
          result.status,

        finalUrl:
          result.finalUrl,

        contentType:
          result.contentType,

        htmlLength:
          html.length,

        redirectedToLogin:
          result.finalUrl.includes(
            '/accounts/login'
          ),

        containsLoginText:
          /accounts\/login|login_required|login required/i.test(
            html
          ),

        hasOgImage:
          Boolean(
            ogImage
          ),

        ogImage:
          ogImage
            ? ogImage.substring(
                0,
                1000
              )
            : '',

        hasOgTitle:
          Boolean(
            ogTitle
          ),

        ogTitle:
          ogTitle.substring(
            0,
            500
          ),

        hasOgDescription:
          Boolean(
            ogDescription
          ),

        ogDescription:
          ogDescription.substring(
            0,
            1000
          ),

        hasOgVideo:
          Boolean(
            ogVideo
          ),

        containsIsVideo:
          /"is_video"\s*:\s*true/i.test(
            html
          ),

        containsVideoVersions:
          /"video_versions"/i.test(
            html
          ),

        containsVideoUrl:
          /"video_url"/i.test(
            html
          ),

        staticCdnCount:
          (
            html.match(
              /static\.cdninstagram\.com/gi
            ) || []
          ).length,

        cdnInstagramCount:
          (
            html.match(
              /cdninstagram/gi
            ) || []
          ).length,

        scontentCount:
          (
            html.match(
              /scontent/gi
            ) || []
          ).length,

        fbcdnCount:
          (
            html.match(
              /fbcdn/gi
            ) || []
          ).length,

        mediaFieldCounts,

        candidateCount:
          candidates.length,

        candidates:
          candidates
            .slice(
              0,
              15
            )
            .map(
              (
                candidate
              ) => ({
                score:
                  candidate.score,

                reason:
                  candidate.reason,

                url:
                  candidate.url.substring(
                    0,
                    1000
                  ),
              })
            ),

        ogImageSnippet:
          ogImageSnippet.substring(
            0,
            2500
          ),

        htmlStart:
          html.substring(
            0,
            3000
          ),
      };
    } catch (
      err: unknown
    ) {
      htmlTest = {
        error:
          err instanceof Error
            ? err.message
            : String(err),
      };
    }

    /* ---------------------------------------------
       PLAYWRIGHT TEST
       --------------------------------------------- */

    let playwrightTest:
      Record<
        string,
        unknown
      >;

    try {
      const browserResult =
        await extractInstagramWithPlaywright(
          canonicalUrl
        );

      playwrightTest = {
        success:
          browserResult.success,

        type:
          browserResult.type,

        title:
          browserResult.title,

        finalUrl:
          browserResult.finalUrl,

        pageTitle:
          browserResult.pageTitle,

        imageCount:
          browserResult.images.length,

        images:
          browserResult.images
            .slice(
              0,
              20
            )
            .map(
              (
                image
              ) => ({
                url:
                  image.url.substring(
                    0,
                    1200
                  ),

                width:
                  image.width,

                height:
                  image.height,

                source:
                  image.source,
              })
            ),

        hasVideo:
          Boolean(
            browserResult.videoUrl
          ),

        videoUrl:
          browserResult.videoUrl
            ? browserResult.videoUrl.substring(
                0,
                1200
              )
            : '',

        error:
          browserResult.error ||
          '',
      };
    } catch (
      err: unknown
    ) {
      playwrightTest = {
        error:
          err instanceof Error
            ? err.message
            : String(err),
      };
    }

    /* ---------------------------------------------
       GALLERY-DL TEST
       --------------------------------------------- */

    let galleryTest:
      Record<
        string,
        unknown
      >;

    try {
      const result =
        await runCommand(
          'gallery-dl',
          [
            '-j',
            '--no-download',
            canonicalUrl,
          ],
          20000
        );

      galleryTest = {
        exitCode:
          result.code,

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
      };
    } catch (
      err: unknown
    ) {
      if (
        err instanceof
        CommandExecutionError
      ) {
        galleryTest = {
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
        };
      } else {
        galleryTest = {
          error:
            err instanceof Error
              ? err.message
              : String(err),
        };
      }
    }

    /* ---------------------------------------------
       OUR ACTUAL EXTRACTOR
       --------------------------------------------- */

    let extractorTest:
      Record<
        string,
        unknown
      >;

    try {
      const result =
        await analyzeInstagram(
          canonicalUrl
        );

      extractorTest = {
        type:
          result.type,

        title:
          result.title ||
          '',

        imageUrl:
          result.imageUrl ||
          '',

        thumbnail:
          result.thumbnail ||
          '',

        ext:
          result.ext ||
          '',

        items:
          result.items ||
          [],

        debug:
          result.debug ||
          {},
      };
    } catch (
      err: unknown
    ) {
      extractorTest = {
        error:
          err instanceof Error
            ? err.message
            : String(err),
      };
    }

    res.json({
      success: true,

      url:
        canonicalUrl,

      html:
        htmlTest,

      playwright:
        playwrightTest,

      galleryDl:
        galleryTest,

      extractor:
        extractorTest,
    });
  }
);

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
      status: 'ok',

      service:
        'linkdrop-backend',

      time:
        new Date().toISOString(),

      activeDownloads:
        activeDownloadsCount,

      chromium:
        CHROMIUM_PATH,
    });
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
        success: false,

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
        success: false,

        message:
          safety.error ||
          'Link tidak dapat diproses.',
      });

      return;
    }

    /*
     * Instagram post.
     */

    if (
      safety.platform ===
        'instagram' &&
      url.includes('/p/')
    ) {
      const instagram =
        await analyzeInstagram(
          url
        );

      /*
       * Instagram Photo / Carousel.
       */

      if (
        instagram.type ===
          'image' &&
        instagram.imageUrl
      ) {
        res.json({
          success: true,

          platform:
            'instagram',

          type: 'image',

          title:
            instagram.title ||
            'Instagram Photo',

          thumbnail:
            instagram.thumbnail ||
            '',

          uploader:
            'Instagram User',

          items:
            instagram.items ||
            [
              {
                index: 0,

                type:
                  'image',

                url:
                  instagram.imageUrl,

                ext:
                  instagram.ext ||
                  'jpg',
              },
            ],

          url,
        });

        return;
      }

      /*
       * Instagram video:
       * Continue into yt-dlp.
       */
    }

    /* ---------------------------------------------
       VIDEO PIPELINE
       --------------------------------------------- */

    try {
      const result =
        await runCommand(
          'yt-dlp',
          [
            '--dump-json',

            '--no-playlist',

            '--skip-download',

            '--no-warnings',

            '--no-check-certificates',

            url,
          ],
          25000
        );

      const meta =
        JSON.parse(
          result.stdout
        );

      res.json({
        success: true,

        platform:
          safety.platform,

        type: 'video',

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

        formats: [
          {
            id: 'best',

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
            id: 'audio',

            label:
              'Audio MP3',

            extension:
              'mp3',

            quality:
              'High Audio',

            type:
              'audio',
          },
        ],
      });
    } catch (
      err: unknown
    ) {
      console.error(
        '[Analyze Error]',
        err
      );

      res.status(500).json({
        success: false,

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
        success: false,

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
      isAudio
        ? 'mp3'
        : 'mp4';

    const jobId =
      crypto
        .randomBytes(8)
        .toString('hex');

    const outputTemplate =
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

        outputTemplate,
      ];

      if (isAudio) {
        args.push(
          '--extract-audio',

          '--audio-format',

          'mp3',

          '--audio-quality',

          '0'
        );
      } else {
        args.push(
          '--merge-output-format',

          'mp4',

          '--postprocessor-args',

          'Merger+ffmpeg:-movflags +faststart'
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
        `LinkDrop_${
          safety.platform ||
          'Media'
        }_${
          Date.now()
            .toString()
            .slice(-4)
        }.${ext}`;

      res.setHeader(
        'Content-Type',

        isAudio
          ? 'audio/mpeg'
          : 'video/mp4'
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

      stream.pipe(res);

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
      console.error(
        '[Download Error]',
        err
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

/* =========================================================
   DOWNLOAD IMAGE
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

    let targetImageUrl = '';

    /*
     * Prefer supplied imageUrl first.
     *
     * This is important for carousel:
     * each item can have its own CDN URL.
     */

    if (
      imageUrl &&
      typeof imageUrl ===
        'string'
    ) {
      const validated =
        validateInstagramMediaUrl(
          imageUrl
        );

      if (validated) {
        targetImageUrl =
          validated;
      }
    }

    /*
     * If no imageUrl was supplied,
     * extract from original Instagram URL.
     */

    if (
      !targetImageUrl &&
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
        const result =
          await analyzeInstagram(
            url
          );

        if (
          result.type ===
            'image' &&
          result.imageUrl
        ) {
          targetImageUrl =
            result.imageUrl;
        }
      }
    }

    if (
      !targetImageUrl
    ) {
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

      if (
        !isAllowedInstagramMediaHost(
          parsed.hostname
        )
      ) {
        res.status(400).json({
          success: false,

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

      let response:
        globalThis.Response;

      try {
        response =
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
      } finally {
        clearTimeout(
          timeout
        );
      }

      if (
        !response.ok
      ) {
        throw new Error(
          `Image request failed: ${response.status}`
        );
      }

      const contentType =
        response.headers.get(
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
          await response.arrayBuffer()
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

      let imageExt = 'jpg';

      if (
        contentType.includes(
          'png'
        )
      ) {
        imageExt = 'png';
      } else if (
        contentType.includes(
          'webp'
        )
      ) {
        imageExt = 'webp';
      } else if (
        contentType.includes(
          'jpeg'
        )
      ) {
        imageExt = 'jpg';
      }

      const filename =
        `LinkDrop_Instagram_Photo_${
          Date.now()
            .toString()
            .slice(-4)
        }.${imageExt}`;

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
    } catch (
      err: unknown
    ) {
      console.error(
        '[Download Image Error]',
        err
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
          15 * 60 * 1000
        ) {
          fs.unlinkSync(
            fullPath
          );
        }
      }
    } catch {
      // ignore cleanup errors
    }
  },
  10 * 60 * 1000
);

/* =========================================================
   START
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

    console.log(
      `[LinkDrop Server] Chromium: ${CHROMIUM_PATH}`
    );
  }
);
