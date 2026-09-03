import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { chromium, Browser, Page } from "playwright-core";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";

const execFileAsync = promisify(execFile);

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
  })
);
app.use(express.json({ limit: "1mb" }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api/", limiter);

const PORT = Number(process.env.PORT || 3000);
const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH || "/usr/bin/chromium";

const MAX_INSTAGRAM_CAROUSEL_ITEMS = 30;

type MediaType = "image" | "video";

interface ExtractedMediaItem {
  type: MediaType;
  url: string;
  thumbnail?: string;
}

interface InstagramResult {
  success: boolean;
  url: string;
  isVideoPost: boolean;
  title: string;
  thumbnail: string;
  itemCount: number;
  items: ExtractedMediaItem[];
  error?: string;
}

const AnalyzeSchema = z.object({
  url: z.string().url(),
});

const DownloadSchema = z.object({
  url: z.string().url(),
});

function isInstagramUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);

    return (
      u.hostname === "instagram.com" ||
      u.hostname === "www.instagram.com"
    );
  } catch {
    return false;
  }
}

function cleanInstagramUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);

    return `https://www.instagram.com${u.pathname}`;
  } catch {
    return rawUrl;
  }
}

function isAllowedInstagramMediaUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();

    return (
      host.endsWith("cdninstagram.com") ||
      host.endsWith("fbcdn.net") ||
      host.endsWith("instagram.com")
    );
  } catch {
    return false;
  }
}

function normalizeMediaUrl(rawUrl: string): string | null {
  if (!rawUrl) return null;

  try {
    const decoded = rawUrl.replace(/&amp;/g, "&");

    if (!isAllowedInstagramMediaUrl(decoded)) {
      return null;
    }

    return decoded;
  } catch {
    return null;
  }
}

function uniqueMedia(
  items: ExtractedMediaItem[]
): ExtractedMediaItem[] {
  const seen = new Set<string>();
  const result: ExtractedMediaItem[] = [];

  for (const item of items) {
    if (!item.url) continue;

    let key = item.url;

    try {
      const u = new URL(item.url);
      key = `${u.hostname}${u.pathname}`;
    } catch {}

    if (seen.has(key)) continue;

    seen.add(key);
    result.push(item);
  }

  return result;
}

async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--no-zygote",
      "--single-process",
    ],
  });
}

async function waitForInstagram(
  page: Page
): Promise<void> {
  await page.waitForTimeout(2500);

  try {
    await page.waitForLoadState("domcontentloaded", {
      timeout: 10000,
    });
  } catch {}

  await page.waitForTimeout(2500);
}

async function getPageText(
  page: Page
): Promise<string> {
  try {
    return await page.locator("body").innerText({
      timeout: 5000,
    });
  } catch {
    return "";
  }
}

function looksLikeInstagramLoginPage(
  text: string
): boolean {
  const lower = text.toLowerCase();

  return (
    lower.includes("log in") &&
    lower.includes("sign up")
  );
}

function looksLikeInstagramChallenge(
  text: string
): boolean {
  const lower = text.toLowerCase();

  return (
    lower.includes("challenge_required") ||
    lower.includes("suspicious login") ||
    lower.includes("confirm your identity") ||
    lower.includes("try again later")
  );
}

async function extractFromPerformanceEntries(
  page: Page
): Promise<ExtractedMediaItem[]> {
  try {
    const urls = await page.evaluate(() => {
      const entries = performance.getEntriesByType(
        "resource"
      ) as PerformanceResourceTiming[];

      return entries
        .map((e) => e.name)
        .filter(Boolean);
    });

    const items: ExtractedMediaItem[] = [];

    for (const rawUrl of urls) {
      const url = normalizeMediaUrl(rawUrl);

      if (!url) continue;

      const lower = url.toLowerCase();

      if (
        lower.includes(".mp4") ||
        lower.includes("/v/t") ||
        lower.includes("video")
      ) {
        items.push({
          type: "video",
          url,
        });
      } else {
        items.push({
          type: "image",
          url,
        });
      }
    }

    return uniqueMedia(items);
  } catch {
    return [];
  }
}

async function extractVisibleMedia(
  page: Page
): Promise<ExtractedMediaItem[]> {
  const items = await page.evaluate(() => {
    const result: {
      type: "image" | "video";
      url: string;
      thumbnail?: string;
      area: number;
    }[] = [];

    const addImage = (
      el: HTMLImageElement,
      url?: string
    ) => {
      const src =
        url ||
        el.currentSrc ||
        el.src ||
        el.getAttribute("data-src") ||
        "";

      if (!src) return;

      const rect = el.getBoundingClientRect();

      const area =
        Math.max(0, rect.width) *
        Math.max(0, rect.height);

      result.push({
        type: "image",
        url: src,
        area,
      });
    };

    const addVideo = (
      el: HTMLVideoElement,
      url?: string
    ) => {
      const src =
        url ||
        el.currentSrc ||
        el.src ||
        el.querySelector("source")?.src ||
        "";

      if (!src) return;

      const rect = el.getBoundingClientRect();

      const area =
        Math.max(0, rect.width) *
        Math.max(0, rect.height);

      result.push({
        type: "video",
        url: src,
        thumbnail: el.poster || undefined,
        area,
      });
    };

    document
      .querySelectorAll("img")
      .forEach((el) => addImage(el));

    document
      .querySelectorAll("video")
      .forEach((el) => addVideo(el));

    return result
      .sort((a, b) => b.area - a.area)
      .slice(0, 20);
  });

  const normalized: ExtractedMediaItem[] = [];

  for (const item of items) {
    const url = normalizeMediaUrl(item.url);

    if (!url) continue;

    normalized.push({
      type: item.type,
      url,
      thumbnail: item.thumbnail
        ? normalizeMediaUrl(item.thumbnail) ||
          undefined
        : undefined,
    });
  }

  return uniqueMedia(normalized);
}

async function getBestCurrentMedia(
  page: Page
): Promise<ExtractedMediaItem | null> {
  const candidates =
    await extractVisibleMedia(page);

  if (!candidates.length) {
    return null;
  }

  return candidates[0];
}

async function findNextButton(page: Page) {
  const selectors = [
    'button[aria-label*="Next"]',
    'button[aria-label*="next"]',
    'button[aria-label*="Berikut"]',
    'button[aria-label*="berikut"]',
    'div[role="button"][aria-label*="Next"]',
    'div[role="button"][aria-label*="next"]',
    'div[role="button"][aria-label*="Berikut"]',
    'div[role="button"][aria-label*="berikut"]',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector);

    try {
      const count = await locator.count();

      if (count > 0) {
        for (
          let i = 0;
          i < Math.min(count, 5);
          i++
        ) {
          const el = locator.nth(i);

          if (
            await el
              .isVisible()
              .catch(() => false)
          ) {
            return el;
          }
        }
      }
    } catch {}
  }

  return null;
}

async function extractInstagramWithPlaywright(
  rawUrl: string
): Promise<InstagramResult> {
  const url = cleanInstagramUrl(rawUrl);

  let browser: Browser | null = null;

  try {
    browser = await launchBrowser();

    const context = await browser.newContext({
      viewport: {
        width: 1280,
        height: 900,
      },
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "Asia/Jakarta",
    });

    const page = await context.newPage();

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    await waitForInstagram(page);

    const finalUrl = page.url();

    const text = await getPageText(page);

    if (looksLikeInstagramChallenge(text)) {
      return {
        success: false,
        url,
        isVideoPost: false,
        title: "",
        thumbnail: "",
        itemCount: 0,
        items: [],
        error:
          "Instagram meminta verifikasi/challenge saat diakses dari server.",
      };
    }

    if (
      finalUrl.includes("/accounts/login") ||
      looksLikeInstagramLoginPage(text)
    ) {
      return {
        success: false,
        url,
        isVideoPost: false,
        title: "",
        thumbnail: "",
        itemCount: 0,
        items: [],
        error:
          "Instagram mengarahkan server ke halaman login.",
      };
    }

    const items: ExtractedMediaItem[] = [];

    const firstMedia =
      await getBestCurrentMedia(page);

    if (firstMedia) {
      items.push(firstMedia);
    }

    if (!items.length) {
      const networkItems =
        await extractFromPerformanceEntries(page);

      if (networkItems.length) {
        items.push(networkItems[0]);
      }
    }

    const visited = new Set<string>();

    for (
      let slide = 0;
      slide <
      MAX_INSTAGRAM_CAROUSEL_ITEMS - 1;
      slide++
    ) {
      const current =
        items[items.length - 1];

      if (!current) break;

      let currentKey = current.url;

      try {
        const u = new URL(current.url);

        currentKey =
          `${u.hostname}${u.pathname}`;
      } catch {}

      visited.add(currentKey);

      const nextButton =
        await findNextButton(page);

      if (!nextButton) {
        break;
      }

      await nextButton
        .click({
          timeout: 3000,
        })
        .catch(() => null);

      await page.waitForTimeout(900);

      let nextMedia =
        await getBestCurrentMedia(page);

      if (
        nextMedia &&
        visited.has(
          (() => {
            try {
              const u =
                new URL(nextMedia.url);

              return `${u.hostname}${u.pathname}`;
            } catch {
              return nextMedia.url;
            }
          })()
        )
      ) {
        await page.waitForTimeout(1200);

        nextMedia =
          await getBestCurrentMedia(page);
      }

      if (!nextMedia) {
        break;
      }

      let nextKey = nextMedia.url;

      try {
        const u = new URL(nextMedia.url);

        nextKey =
          `${u.hostname}${u.pathname}`;
      } catch {}

      if (visited.has(nextKey)) {
        break;
      }

      if (
        nextMedia.type === "video" &&
        !nextMedia.url
      ) {
        break;
      }

      items.push(nextMedia);
      visited.add(nextKey);
    }

    const finalItems =
      uniqueMedia(items).slice(
        0,
        MAX_INSTAGRAM_CAROUSEL_ITEMS
      );

    if (!finalItems.length) {
      const networkItems =
        await extractFromPerformanceEntries(page);

      const usableNetworkItems =
        networkItems
          .filter((item) =>
            isAllowedInstagramMediaUrl(
              item.url
            )
          )
          .slice(
            0,
            MAX_INSTAGRAM_CAROUSEL_ITEMS
          );

      if (usableNetworkItems.length) {
        const hasVideo =
          usableNetworkItems.some(
            (item) =>
              item.type === "video"
          );

        return {
          success: true,
          url,
          isVideoPost:
            hasVideo &&
            usableNetworkItems.length === 1,
          title: "",
          thumbnail:
            usableNetworkItems[0]?.url ||
            "",
          itemCount:
            usableNetworkItems.length,
          items: usableNetworkItems,
        };
      }
    }

    if (!finalItems.length) {
      return {
        success: false,
        url,
        isVideoPost: false,
        title: "",
        thumbnail: "",
        itemCount: 0,
        items: [],
        error:
          "Media postingan Instagram tidak berhasil ditemukan.",
      };
    }

    if (
      finalItems.length === 1 &&
      finalItems[0].type === "video"
    ) {
      return {
        success: true,
        url,
        isVideoPost: true,
        title: "",
        thumbnail:
          finalItems[0].thumbnail ||
          finalItems[0].url,
        itemCount: 1,
        items: finalItems,
      };
    }

    return {
      success: true,
      url,
      isVideoPost: false,
      title: "",
      thumbnail:
        finalItems[0]?.thumbnail ||
        finalItems[0]?.url ||
        "",
      itemCount: finalItems.length,
      items: finalItems,
    };
  } catch (error: any) {
    return {
      success: false,
      url,
      isVideoPost: false,
      title: "",
      thumbnail: "",
      itemCount: 0,
      items: [],
      error:
        error?.message ||
        "Gagal memproses postingan Instagram.",
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

/* =========================
   APIFY INSTAGRAM
========================= */

async function extractInstagramWithApify(
  rawUrl: string
) {
  const token =
    process.env.APIFY_API_TOKEN;

  if (!token) {
    return {
      success: false,
      error:
        "APIFY_API_TOKEN belum dikonfigurasi.",
    };
  }

  try {
    const response = await fetch(
      "https://api.apify.com/v2/actors/crawlerbros~instagram-post-scraper/run-sync-get-dataset-items",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          post_urls: [rawUrl],
        }),
        signal: AbortSignal.timeout(
          120000
        ),
      }
    );

    if (!response.ok) {
      const text =
        await response.text();

      return {
        success: false,
        error:
          `Apify error ${response.status}: ${text}`,
      };
    }

    const data =
      await response.json();

    if (
      !Array.isArray(data) ||
      data.length === 0
    ) {
      return {
        success: false,
        error:
          "Instagram post tidak ditemukan.",
      };
    }

    const post = data[0];

    if (post.status !== "success") {
      return {
        success: false,
        error:
          `Instagram: ${
            post.status ||
            "gagal mengambil post"
          }.`,
      };
    }

    const mediaItems =
      Array.isArray(post.media_items)
        ? post.media_items.slice(
            0,
            MAX_INSTAGRAM_CAROUSEL_ITEMS
          )
        : [];

    const normalizedItems: ExtractedMediaItem[] =
      mediaItems
        .map((item: any) => {
          const mediaUrl =
            typeof item.url === "string"
              ? item.url
              : "";

          if (!mediaUrl) {
            return null;
          }

          return {
            type:
              String(item.type)
                .toLowerCase() ===
              "video"
                ? "video"
                : "image",
            url: mediaUrl,
            thumbnail:
              typeof item.thumbnail_url ===
              "string"
                ? item.thumbnail_url
                : mediaUrl,
          } as ExtractedMediaItem;
        })
        .filter(
          (
            item:
              | ExtractedMediaItem
              | null
          ): item is ExtractedMediaItem =>
            item !== null
        );

    return {
      success: true,
      url:
        post.post_url ||
        rawUrl,
      title:
        post.caption ||
        "Instagram Post",
      thumbnail:
        post.thumbnail_url ||
        normalizedItems[0]?.thumbnail ||
        "",
      itemCount:
        normalizedItems.length,
      items: normalizedItems,
    };
  } catch (error: any) {
    return {
      success: false,
      error:
        error?.message ||
        "Gagal mengambil Instagram dari Apify.",
    };
  }
}

async function runYtDlp(
  url: string,
  outputDir: string
) {
  const outputTemplate =
    path.join(
      outputDir,
      "%(title).100B-%(id)s.%(ext)s"
    );

  const args = [
    "--no-playlist",
    "--no-warnings",
    "--restrict-filenames",
    "-o",
    outputTemplate,
    url,
  ];

  return execFileAsync(
    "yt-dlp",
    args,
    {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    }
  );
}

function safeFilename(
  name: string
): string {
  return (
    name
      .replace(
        /[<>:"/\\|?*\x00-\x1F]/g,
        "_"
      )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180) ||
    "download"
  );
}

async function downloadRemoteInstagramMedia(
  rawUrl: string
): Promise<{
  buffer: Buffer;
  contentType: string;
}> {
  const url =
    normalizeMediaUrl(rawUrl);

  if (!url) {
    throw new Error(
      "URL media Instagram tidak diizinkan."
    );
  }

  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
      Referer:
        "https://www.instagram.com/",
    },
    signal:
      AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(
      `Gagal mengambil media Instagram (${response.status}).`
    );
  }

  const arrayBuffer =
    await response.arrayBuffer();

  const buffer =
    Buffer.from(arrayBuffer);

  const contentType =
    response.headers.get(
      "content-type"
    ) ||
    "application/octet-stream";

  return {
    buffer,
    contentType,
  };
}

/* =========================
   HEALTH
========================= */

app.get(
  "/api/health",
  (_req, res) => {
    res.json({
      success: true,
      status: "ok",
      service:
        "linkdrop-backend",
      chromium:
        CHROMIUM_PATH,
      timestamp:
        new Date().toISOString(),
    });
  }
);

/* =========================
   DEBUG INSTAGRAM
========================= */

app.get(
  "/api/debug-instagram",
  async (req, res) => {
    const rawUrl =
      String(
        req.query.url || ""
      );

    if (!rawUrl) {
      return res.status(400).json({
        success: false,
        message:
          "Query parameter url diperlukan.",
      });
    }

    if (!isInstagramUrl(rawUrl)) {
      return res.status(400).json({
        success: false,
        message:
          "URL harus berasal dari Instagram.",
      });
    }

    const result =
      await extractInstagramWithPlaywright(
        rawUrl
      );

    return res.json(result);
  }
);

/* =========================
   DEBUG YT-DLP INSTAGRAM
========================= */

app.get(
  "/api/debug-ytdlp",
  async (req, res) => {
    const rawUrl =
      String(
        req.query.url || ""
      );

    if (!rawUrl) {
      return res.status(400).json({
        success: false,
        message:
          "Query parameter url diperlukan.",
      });
    }

    try {
      const result =
        await execFileAsync(
          "yt-dlp",
          [
            "--dump-single-json",
            "--no-playlist",
            "--no-warnings",
            "--no-check-certificates",
            rawUrl,
          ],
          {
            timeout: 90000,
            maxBuffer:
              20 * 1024 * 1024,
          }
        );

      const data =
        JSON.parse(
          result.stdout
        );

      return res.json({
        success: true,
        id:
          data.id || "",
        title:
          data.title || "",
        webpage_url:
          data.webpage_url ||
          rawUrl,
        extractor:
          data.extractor ||
          "",
        ext:
          data.ext || "",
        thumbnail:
          data.thumbnail || "",
        duration:
          data.duration ||
          null,
        has_url:
          Boolean(data.url),
        formats_count:
          Array.isArray(
            data.formats
          )
            ? data.formats.length
            : 0,
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message:
          error?.stderr ||
          error?.stdout ||
          error?.message ||
          "yt-dlp gagal memproses URL.",
      });
    }
  }
);

/* =========================
   ANALYZE
========================= */

app.post(
  "/api/analyze",
  async (req, res) => {
    try {
      const parsed =
        AnalyzeSchema.parse(
          req.body
        );

      const rawUrl =
        parsed.url.trim();

      if (isInstagramUrl(rawUrl)) {
        /*
         * Pertama tetap coba jalur
         * Playwright yang sudah bekerja
         * untuk video Instagram.
         */
        const instagram =
          await extractInstagramWithPlaywright(
            rawUrl
          );

        /*
         * Single video:
         * pertahankan behavior lama.
         */
        if (
          instagram.success &&
          instagram.isVideoPost &&
          instagram.items.length === 1
        ) {
          return res.json({
            success: true,
            type: "video",
            url:
              instagram.url,
            title:
              instagram.title ||
              "Instagram Video",
            thumbnail:
              instagram.thumbnail ||
              "",
            itemCount: 1,
            items:
              instagram.items,
          });
        }

        /*
         * Foto / carousel:
         * gunakan Apify.
         */
        console.log("APIFY START", rawUrl);
        
        const apify =
          await extractInstagramWithApify(
            rawUrl
          );

                if (
  apify.success &&
  Array.isArray(apify.items) &&
  apify.items.length > 0
) {
          return res.json({
            success: true,
            type: "image",
            url:
              apify.url,
            title:
              apify.title ||
              "Instagram Post",
            thumbnail:
              apify.thumbnail ||
              "",
            itemCount:
              apify.itemCount,
            items:
              apify.items,
          });
        }

        /*
         * Kalau Apify gagal,
         * gunakan hasil Playwright
         * kalau ternyata tersedia.
         */
        if (
          instagram.success &&
          instagram.items.length > 0
        ) {
          return res.json({
            success: true,
            type: "image",
            url:
              instagram.url,
            title:
              instagram.title ||
              "Instagram Post",
            thumbnail:
              instagram.thumbnail ||
              "",
            itemCount:
              instagram.items.length,
            items:
              instagram.items,
          });
        }

        /*
         * Fallback terakhir:
         * coba yt-dlp.
         */
        try {
          const tempDir =
            await fs.mkdtemp(
              path.join(
                os.tmpdir(),
                "letsedrop-"
              )
            );

          try {
            const info =
              await execFileAsync(
                "yt-dlp",
                [
                  "--dump-single-json",
                  "--no-playlist",
                  "--no-warnings",
                  rawUrl,
                ],
                {
                  timeout: 60000,
                  maxBuffer:
                    10 * 1024 * 1024,
                }
              );

            const data =
              JSON.parse(
                info.stdout
              );

            return res.json({
              success: true,
              type:
                data.ext === "jpg" ||
                data.ext === "jpeg" ||
                data.ext === "png"
                  ? "image"
                  : "video",
              url: rawUrl,
              title:
                data.title ||
                "Instagram",
              thumbnail:
                data.thumbnail ||
                "",
              itemCount: 1,
              items: [
                {
                  type:
                    data.ext === "jpg" ||
                    data.ext === "jpeg" ||
                    data.ext === "png"
                      ? "image"
                      : "video",
                  url:
                    data.url ||
                    rawUrl,
                  thumbnail:
                    data.thumbnail ||
                    undefined,
                },
              ],
            });
          } finally {
            await fs.rm(
              tempDir,
              {
                recursive: true,
                force: true,
              }
            );
          }
        } catch {}

        return res.status(422).json({
          success: false,
          message:
            apify.error ||
            instagram.error ||
            "Postingan Instagram tidak ditemukan.",
        });
      }

      /*
       * Non-Instagram:
       * gunakan yt-dlp untuk URL publik
       * yang didukung.
       */
      try {
        const info =
          await execFileAsync(
            "yt-dlp",
            [
              "--dump-single-json",
              "--no-playlist",
              "--no-warnings",
              rawUrl,
            ],
            {
              timeout: 60000,
              maxBuffer:
                10 * 1024 * 1024,
            }
          );

        const data =
          JSON.parse(
            info.stdout
          );

        return res.json({
          success: true,
          type: "video",
          url: rawUrl,
          title:
            data.title ||
            "Video",
          thumbnail:
            data.thumbnail ||
            "",
          itemCount: 1,
          items: [
            {
              type: "video",
              url:
                data.webpage_url ||
                rawUrl,
              thumbnail:
                data.thumbnail ||
                undefined,
            },
          ],
        });
      } catch (error: any) {
        return res.status(422).json({
          success: false,
          message:
            error?.stderr ||
            error?.message ||
            "URL tidak dapat diproses.",
        });
      }
    } catch (error: any) {
      if (
        error instanceof
        z.ZodError
      ) {
        return res.status(400).json({
          success: false,
          message:
            "URL tidak valid.",
        });
      }

      return res.status(500).json({
        success: false,
        message:
          error?.message ||
          "Gagal memproses URL.",
      });
    }
  }
);

/* =========================
   DOWNLOAD VIDEO
========================= */

app.post(
  "/api/download",
  async (req, res) => {
    let tempDir:
      string | null = null;

    try {
      const parsed =
        DownloadSchema.parse(
          req.body
        );

      tempDir =
        await fs.mkdtemp(
          path.join(
            os.tmpdir(),
            "letsedrop-download-"
          )
        );

      await runYtDlp(
        parsed.url,
        tempDir
      );

      const files =
        await fs.readdir(
          tempDir
        );

      const mediaFiles =
        files.filter(
          (file) =>
            !file.endsWith(".part") &&
            !file.endsWith(".ytdl")
        );

      if (!mediaFiles.length) {
        throw new Error(
          "File hasil download tidak ditemukan."
        );
      }

      const filename =
        mediaFiles[0];

      const filePath =
        path.join(
          tempDir,
          filename
        );

      const stat =
        await fs.stat(
          filePath
        );

      res.setHeader(
        "Content-Length",
        stat.size
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeFilename(
          filename
        )}"`
      );

      res.sendFile(
        filePath,
        async () => {
          if (tempDir) {
            await fs.rm(
              tempDir,
              {
                recursive: true,
                force: true,
              }
            );
          }
        }
      );

      return;
    } catch (error: any) {
      if (tempDir) {
        await fs.rm(
          tempDir,
          {
            recursive: true,
            force: true,
          }
        ).catch(() => {});
      }

      return res.status(500).json({
        success: false,
        message:
          error?.stderr ||
          error?.message ||
          "Gagal mendownload media.",
      });
    }
  }
);

/* =========================
   DOWNLOAD INSTAGRAM MEDIA
========================= */

app.post(
  "/api/download-carousel",
  async (req, res) => {
    try {
      const body = z
        .object({
          url: z.string().url(),
          type: z.enum([
            "image",
            "video",
          ]),
        })
        .parse(req.body);

      const result =
        await downloadRemoteInstagramMedia(
          body.url
        );

      const extension =
        body.type === "video"
          ? "mp4"
          : result.contentType.includes(
              "png"
            )
          ? "png"
          : "jpg";

      const filename =
        `letsedrop-${crypto
          .randomBytes(4)
          .toString("hex")}.${extension}`;

      res.setHeader(
        "Content-Type",
        result.contentType
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );

      res.send(result.buffer);
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message:
          error?.message ||
          "Gagal mendownload media Instagram.",
      });
    }
  }
);

/* =========================
   DOWNLOAD IMAGE
========================= */

app.post(
  "/api/download-image",
  async (req, res) => {
    try {
      const body = z
        .object({
          url: z.string().url(),
        })
        .parse(req.body);

      const result =
        await downloadRemoteInstagramMedia(
          body.url
        );

      const extension =
        result.contentType.includes(
          "png"
        )
          ? "png"
          : result.contentType.includes(
              "webp"
            )
          ? "webp"
          : "jpg";

      const filename =
        `letsedrop-${crypto
          .randomBytes(4)
          .toString("hex")}.${extension}`;

      res.setHeader(
        "Content-Type",
        result.contentType
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );

      res.send(result.buffer);
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message:
          error?.message ||
          "Gagal mendownload gambar.",
      });
    }
  }
);

/* =========================
   START
========================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Letsedrop backend running on port ${PORT}`
    );
  }
);
