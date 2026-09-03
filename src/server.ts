/**
 * LinkDrop Production Server - Final Version
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
import { chromium, Browser, Route } from 'playwright';

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '500', 10);
const DOWNLOAD_TIMEOUT_MS = parseInt(process.env.DOWNLOAD_TIMEOUT_MS || '300000', 10);
const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '5', 10);
const TEMP_DIR = path.resolve(process.env.TEMP_DIR || './tmp');

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  exposedHeaders: ['Content-Disposition', 'Content-Type', 'Content-Length'],
}));

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

  constructor(message: string, code: number, stdout: string, stderr: string, timedOut: boolean = false) {
    super(message);
    this.name = 'CommandExecutionError';
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
    this.timedOut = timedOut;
  }
}

async function validateUrlSafety(inputUrl: string): Promise<{ safe: boolean; platform?: string; error?: string }> {
  try {
    const parsed = new URL(inputUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { safe: false, error: 'Protokol URL harus HTTP atau HTTPS.' };
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
      return { safe: false, error: 'Platform ini belum didukung.' };
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
        ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc00:') || ip.startsWith('fd00:')
      ) {
        return { safe: false, error: 'Akses ke IP privat/internal diblokir demi keamanan.' };
      }
    }

    return { safe: true, platform: matchedPlatform };
  } catch {
    return { safe: false, error: 'Link tidak valid.' };
  }
}

function sanitizeFilename(rawTitle: string, ext: string): string {
  let clean = rawTitle.replace(/[^a-zA-Z0-9_\-\s]/g, '').trim();
  if (!clean) clean = 'LinkDrop_Media';
  clean = clean.substring(0, 45).replace(/\s+/g, '_');
  const safeExt = ext.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'jpg';
  return `${clean}_${Date.now().toString().slice(-4)}.${safeExt}`;
}

function runCommand(command: string, args: string[], timeoutMs: number = 30000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    console.log(`[EXEC] Menjalankan: ${command} ${args.join(' ')} (timeout: ${timeoutMs}ms)`);
    const child = spawn(command, args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      console.error(`[TIMEOUT] Perintah ${command} dimatikan setelah ${timeoutMs}ms`);
      reject(new CommandExecutionError('TIMEOUT', -1, stdout, stderr, true));
    }, timeoutMs);

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
    }

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      console.error(`[SPAWN ERROR] Gagal menjalankan ${command}:`, err.message);
      reject(new CommandExecutionError(err.message, -1, stdout, stderr, false));
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (timedOut) return;

      const exitCode = code !== null ? code : 1;
      console.log(`[EXIT] ${command} selesai dengan exit code: ${exitCode}`);
      if (stderr.trim().length > 0) {
        console.log(`[STDERR LOG] ${command}:`, stderr.trim().substring(0, 300));
      }

      if (exitCode === 0) {
        resolve({ stdout, stderr, code: exitCode });
      } else {
        const errorMsg = stderr.trim() || `${command} gagal dengan exit code ${exitCode}`;
        reject(new CommandExecutionError(errorMsg, exitCode, stdout, stderr, false));
      }
    });
  });
}

export interface ExtractedImageItem {
  index: number;
  type: 'image';
  url: string;
  thumbnail: string;
  ext: string;
  width?: number;
  height?: number;
}

async function extractInstagramWithPlaywright(targetUrl: string): Promise<{
  success: boolean;
  isVideoPost?: boolean;
  title?: string;
  thumbnail?: string;
  items?: ExtractedImageItem[];
  error?: string;
}> {
  let browser: Browser | null = null;
  console.log(`[INSTAGRAM] Playwright extraction started for: ${targetUrl}`);

  try {
    browser = await chromium.launch({
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
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
    });

    const page = await context.newPage();

    // Type parameter 'route' secara eksplisit sebagai Route untuk menghindari TS7006
    await page.route('**/*', (route: Route) => {
      const reqUrl = route.request().url().toLowerCase();
      if (
        reqUrl.includes('google-analytics') ||
        reqUrl.includes('facebook.com/tr') ||
        reqUrl.includes('logging') ||
        reqUrl.includes('static.cdninstagram.com/rsrc.php')
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
    if (finalUrl.includes('/accounts/login') || finalUrl.includes('login_required')) {
      return {
        success: false,
        error: 'Media ini tidak dapat diakses karena bersifat privat atau membutuhkan login.',
      };
    }

    await page.waitForTimeout(1800);

    const videoCount = await page.locator('article video, main video').count();
    const hasCarousel = (await page.locator('button[aria-label*="Next"], button[aria-label*="Selanjutnya"], [aria-label*="Next"]').count()) > 0;

    if (videoCount > 0 && !hasCarousel) {
      console.log('[INSTAGRAM] Standalone video post terdeteksi via Playwright. Diteruskan ke yt-dlp.');
      return { success: true, isVideoPost: true };
    }

    if (hasCarousel) {
      for (let step = 0; step < 9; step++) {
        const nextButton = page.locator('button[aria-label*="Next"], button[aria-label*="Selanjutnya"]').first();
        if (await nextButton.isVisible()) {
          try {
            await nextButton.click({ timeout: 1200 });
            await page.waitForTimeout(600);
          } catch {
            break;
          }
        } else {
          break;
        }
      }
    }

    const candidates = await page.evaluate(() => {
      const allowedDomains = ['cdninstagram.com', 'fbcdn.net', 'lookaside.fbsbx.com'];
      const results: Array<{
        src: string;
        naturalWidth: number;
        naturalHeight: number;
        alt: string;
      }> = [];

      const imgs = Array.from(document.querySelectorAll('article img, main img, div[role="dialog"] img, img'));

      for (const img of imgs) {
        const htmlImg = img as HTMLImageElement;
        let bestSrc = htmlImg.currentSrc || htmlImg.src;

        if (htmlImg.srcset) {
          const sources = htmlImg.srcset.split(',').map((s) => s.trim());
          let maxCandidateWidth = 0;
          for (const s of sources) {
            const parts = s.split(' ');
            const url = parts[0];
            const widthMatch = parts[1]?.match(/(\d+)w/);
            const w = widthMatch ? parseInt(widthMatch[1], 10) : 0;
            if (w > maxCandidateWidth) {
              maxCandidateWidth = w;
              bestSrc = url;
            }
          }
        }

        if (!bestSrc || bestSrc.startsWith('data:')) continue;

        try {
          const u = new URL(bestSrc);
          const isAllowed = allowedDomains.some((domain) => u.hostname.endsWith(domain));
          if (!isAllowed) continue;
          if (u.hostname.includes('static.cdninstagram.com')) continue;

          const nw = htmlImg.naturalWidth || htmlImg.width || 0;
          const nh = htmlImg.naturalHeight || htmlImg.height || 0;

          if (nw > 0 && nh > 0 && (nw < 220 || nh < 220)) continue;

          results.push({
            src: bestSrc,
            naturalWidth: nw,
            naturalHeight: nh,
            alt: htmlImg.alt || '',
          });
        } catch {}
      }
      return results;
    });

    console.log(`[INSTAGRAM] Ditemukan ${candidates.length} kandidat gambar`);

    const selectedUrls: string[] = [];
    const seenSignatures = new Set<string>();

    for (const item of candidates) {
      try {
        const u = new URL(item.src);
        const signature = u.pathname.split('/').pop()?.split('?')[0] || u.pathname;
        if (!seenSignatures.has(signature)) {
          seenSignatures.add(signature);
          selectedUrls.push(item.src);
        }
      } catch {
        if (!selectedUrls.includes(item.src)) {
          selectedUrls.push(item.src);
        }
      }
    }

    console.log(`[INSTAGRAM] Terpilih ${selectedUrls.length} gambar post asli`);

    if (selectedUrls.length === 0) {
      return {
        success: false,
        error: 'Tidak dapat menemukan foto publik pada postingan ini.',
      };
    }

    let pageTitle = 'Instagram Photo';
    try {
      const metaDesc = await page.locator('meta[property="og:title"], meta[name="description"]').first().getAttribute('content');
      if (metaDesc) pageTitle = metaDesc.substring(0, 70).trim();
    } catch {}

    const items: ExtractedImageItem[] = selectedUrls.map((imgUrl, index) => ({
      index,
      type: 'image',
      url: imgUrl,
      thumbnail: imgUrl,
      ext: imgUrl.toLowerCase().includes('.webp') ? 'webp' : 'jpg',
    }));

    return {
      success: true,
      isVideoPost: false,
      title: pageTitle,
      thumbnail: items[0]?.url || '',
      items,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[INSTAGRAM] Error Playwright:', msg);
    return { success: false, error: msg };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// -------------------------------------------------------------
// Endpoint 1: GET /api/health
// -------------------------------------------------------------
app.get('/api/health', (_req: Request, res: Response): void => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    activeDownloads: activeDownloadsCount,
  });
});

// -------------------------------------------------------------
// Endpoint 2: GET /api/debug-instagram (Diagnostic Tooling)
// -------------------------------------------------------------
app.get('/api/debug-instagram', async (req: Request, res: Response): Promise<void> => {
  const rawUrl = req.query.url;

  if (!rawUrl || typeof rawUrl !== 'string') {
    res.status(400).json({ success: false, message: 'Query parameter url diperlukan.' });
    return;
  }

  const safety = await validateUrlSafety(rawUrl);
  if (!safety.safe || safety.platform !== 'instagram') {
    res.status(400).json({ success: false, message: 'URL harus berupa URL Instagram publik yang valid dan aman.' });
    return;
  }

  let canonicalUrl = rawUrl.trim();
  try {
    const u = new URL(canonicalUrl);
    u.search = '';
    canonicalUrl = u.toString();
  } catch {
    canonicalUrl = rawUrl.trim();
  }

  interface TestResultItem {
    name: string;
    exitCode?: number;
    timedOut?: boolean;
    stdout?: string;
    stderr?: string;
    status?: number;
    finalUrl?: string;
    contentType?: string;
    redirectedToLogin?: boolean;
    error?: string;
  }

  const tests: TestResultItem[] = [];

  const truncate = (str: string, maxLen: number): string => {
    if (!str) return '';
    return str.length > maxLen ? str.substring(0, maxLen) : str;
  };

  try {
    const resBasic = await runCommand('gallery-dl', ['-j', '--no-download', canonicalUrl], 20000);
    tests.push({
      name: 'gallery-dl-basic',
      exitCode: resBasic.code,
      timedOut: false,
      stdout: truncate(resBasic.stdout, 8192),
      stderr: truncate(resBasic.stderr, 4096),
    });
  } catch (err: unknown) {
    if (err instanceof CommandExecutionError) {
      tests.push({
        name: 'gallery-dl-basic',
        exitCode: err.code,
        timedOut: err.timedOut,
        stdout: truncate(err.stdout, 8192),
        stderr: truncate(err.stderr || err.message, 4096),
      });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      tests.push({
        name: 'gallery-dl-basic',
        exitCode: 1,
        timedOut: false,
        stdout: '',
        stderr: truncate(msg, 4096),
      });
    }
  }

  try {
    const resVerbose = await runCommand('gallery-dl', ['-j', '--no-download', '--verbose', canonicalUrl], 20000);
    tests.push({
      name: 'gallery-dl-verbose',
      exitCode: resVerbose.code,
      timedOut: false,
      stdout: truncate(resVerbose.stdout, 8192),
      stderr: truncate(resVerbose.stderr, 6144),
    });
  } catch (err: unknown) {
    if (err instanceof CommandExecutionError) {
      tests.push({
        name: 'gallery-dl-verbose',
        exitCode: err.code,
        timedOut: err.timedOut,
        stdout: truncate(err.stdout, 8192),
        stderr: truncate(err.stderr || err.message, 6144),
      });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      tests.push({
        name: 'gallery-dl-verbose',
        exitCode: 1,
        timedOut: false,
        stdout: '',
        stderr: truncate(msg, 6144),
      });
    }
  }

  try {
    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), 15000);

    const httpRes = await fetch(canonicalUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutTimer);

    const finalUrl = httpRes.url;
    const contentType = httpRes.headers.get('content-type') || '';
    const redirectedToLogin = finalUrl.includes('/accounts/login') || finalUrl.includes('login_required');

    tests.push({
      name: 'direct-http',
      status: httpRes.status,
      finalUrl,
      contentType,
      redirectedToLogin,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    tests.push({
      name: 'direct-http',
      status: 0,
      finalUrl: '',
      contentType: '',
      redirectedToLogin: false,
      error: truncate(errorMsg, 2048),
    });
  }

  res.json({
    success: true,
    url: canonicalUrl,
    tests,
  });
});

// -------------------------------------------------------------
// Endpoint 3: POST /api/analyze
// -------------------------------------------------------------
app.post('/api/analyze', async (req: Request, res: Response): Promise<void> => {
  const { url } = req.body;

  if (!url || typeof url !== 'string') {
    res.status(400).json({ success: false, message: 'URL publik yang didukung diperlukan.' });
    return;
  }

  const safety = await validateUrlSafety(url);
  if (!safety.safe) {
    res.status(400).json({ success: false, message: safety.error || 'Link tidak dapat diproses.' });
    return;
  }

  // 1. Ekstraksi Instagram Foto & Carousel menggunakan Playwright
  if (safety.platform === 'instagram' && url.includes('/p/')) {
    console.log(`[ANALYZE] Menjalankan Playwright untuk Instagram post: ${url}`);
    const igResult = await extractInstagramWithPlaywright(url);

    if (igResult.success && !igResult.isVideoPost && igResult.items && igResult.items.length > 0) {
      console.log(`[ANALYZE] Sukses mengekstrak ${igResult.items.length} gambar via Playwright.`);
      res.json({
        success: true,
        platform: 'instagram',
        type: 'image',
        title: igResult.title || 'Foto Instagram',
        thumbnail: igResult.thumbnail || igResult.items[0].url,
        uploader: 'Instagram User',
        items: igResult.items,
        url: url,
      });
      return;
    }

    if (igResult.isVideoPost) {
      console.log(`[ANALYZE] Postingan Instagram dikonfirmasi video. Diteruskan ke yt-dlp...`);
    } else if (!igResult.success && igResult.error) {
      console.warn(`[ANALYZE] Playwright error: ${igResult.error}`);
    }
  }

  // 2. Pipeline Video Utama (TikTok, Reels, X/Twitter, YouTube) via yt-dlp
  try {
    console.log(`[ANALYZE] Menjalankan yt-dlp untuk video: ${url}`);
    const args = [
      '--dump-json',
      '--no-playlist',
      '--skip-download',
      '--no-warnings',
      '--no-check-certificates',
      url,
    ];

    const { stdout } = await runCommand('yt-dlp', args, 25000);
    const meta = JSON.parse(stdout);

    const formats = [
      {
        id: 'best',
        label: 'Video MP4 (HD)',
        extension: 'mp4',
        quality: 'HD',
        type: 'video',
      },
      {
        id: 'audio',
        label: 'Audio MP3',
        extension: 'mp3',
        quality: 'High Audio',
        type: 'audio',
      },
    ];

    res.json({
      success: true,
      platform: safety.platform,
      type: 'video',
      title: meta.title || 'LinkDrop Video',
      thumbnail: meta.thumbnail || '',
      uploader: meta.uploader || meta.channel || 'Publik',
      duration: meta.duration || 0,
      url: url,
      formats: formats,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('[Analyze Video Error]:', errorMsg);
    const errLower = errorMsg.toLowerCase();

    if (safety.platform === 'instagram') {
      res.status(400).json({
        success: false,
        message: 'Foto/media Instagram ini tidak dapat diproses saat ini.',
      });
      return;
    }

    if (errLower.includes('private') || errLower.includes('login')) {
      res.status(400).json({
        success: false,
        message: 'Media ini tidak dapat diakses karena bersifat privat atau membutuhkan login.',
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: 'Media tidak tersedia atau tidak dapat diproses saat ini.',
    });
  }
});

// -------------------------------------------------------------
// Endpoint 4: POST /api/download (Video MP4 & Audio MP3)
// -------------------------------------------------------------
app.post('/api/download', async (req: Request, res: Response): Promise<void> => {
  const { url, formatId } = req.body;

  if (!url || typeof url !== 'string') {
    res.status(400).json({ success: false, message: 'URL publik yang didukung diperlukan.' });
    return;
  }

  const safety = await validateUrlSafety(url);
  if (!safety.safe) {
    res.status(400).json({ success: false, message: safety.error });
    return;
  }

  if (activeDownloadsCount >= MAX_CONCURRENT_DOWNLOADS) {
    res.status(503).json({ success: false, message: 'Server sibuk. Coba beberapa saat lagi.' });
    return;
  }

  activeDownloadsCount++;

  const isAudio = formatId === 'audio';
  const ext = isAudio ? 'mp3' : 'mp4';
  const jobId = crypto.randomBytes(8).toString('hex');
  const tempOutputTemplate = path.join(TEMP_DIR, `${jobId}.%(ext)s`);
  let finalFilePath = '';

  try {
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--max-filesize', `${MAX_FILE_SIZE_MB}m`,
      '-f', isAudio ? 'bestaudio/best' : 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '-o', tempOutputTemplate,
    ];

    if (isAudio) {
      args.push('--extract-audio', '--audio-format', 'mp3');
    } else {
      args.push('--merge-output-format', 'mp4');
    }

    args.push(url);

    await runCommand('yt-dlp', args, DOWNLOAD_TIMEOUT_MS);

    const files = fs.readdirSync(TEMP_DIR);
    const matched = files.find((f) => f.startsWith(jobId));
    if (!matched) {
      throw new Error('File hasil download tidak ditemukan.');
    }

    finalFilePath = path.join(TEMP_DIR, matched);
    const stats = fs.statSync(finalFilePath);

    const safeFilename = sanitizeFilename(`LinkDrop_${safety.platform || 'Media'}`, ext);
    const mimeType = isAudio ? 'audio/mpeg' : 'video/mp4';

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('Content-Length', stats.size);

    const fileStream = fs.createReadStream(finalFilePath);
    fileStream.pipe(res);

    const cleanup = () => {
      try {
        if (finalFilePath && fs.existsSync(finalFilePath)) {
          fs.unlinkSync(finalFilePath);
        }
      } catch {}
    };

    res.on('finish', cleanup);
    res.on('close', cleanup);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('[Download Video Error]:', errorMsg);
    if (finalFilePath && fs.existsSync(finalFilePath)) {
      try { fs.unlinkSync(finalFilePath); } catch {}
    }
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Gagal memproses download media.' });
    }
  } finally {
    activeDownloadsCount = Math.max(0, activeDownloadsCount - 1);
  }
});

// -------------------------------------------------------------
// Endpoint 5: POST /api/download-image (Secure Image Proxy)
// -------------------------------------------------------------
app.post('/api/download-image', async (req: Request, res: Response): Promise<void> => {
  const { url, imageUrl, itemIndex } = req.body;

  let targetImageUrl = '';

  if (imageUrl && typeof imageUrl === 'string') {
    try {
      const parsedImage = new URL(imageUrl);
      const host = parsedImage.hostname.toLowerCase();
      const isAllowedHost =
        (host.endsWith('cdninstagram.com') && !host.includes('static.cdninstagram.com')) ||
        host.endsWith('fbcdn.net') ||
        host.endsWith('lookaside.fbsbx.com');

      if (isAllowedHost) {
        targetImageUrl = imageUrl;
      } else {
        console.warn(`[Security Alert] Menolak host gambar tidak tepercaya: ${host}`);
      }
    } catch {}
  }

  if (!targetImageUrl && url && typeof url === 'string') {
    const safety = await validateUrlSafety(url);
    if (safety.safe && safety.platform === 'instagram') {
      const extraction = await extractInstagramWithPlaywright(url);
      const targetIndex = typeof itemIndex === 'number' ? itemIndex : 0;
      if (extraction.items && extraction.items[targetIndex]) {
        targetImageUrl = extraction.items[targetIndex].url;
      }
    }
  }

  if (!targetImageUrl) {
    res.status(400).json({ success: false, message: 'Foto Instagram ini tidak dapat diproses saat ini.' });
    return;
  }

  try {
    console.log(`[Download Image] Mengalirkan gambar biner dari CDN: ${new URL(targetImageUrl).hostname}`);
    const controller = new AbortController();
    const fetchTimer = setTimeout(() => controller.abort(), 20000);

    const imgResponse = await fetch(targetImageUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
      signal: controller.signal,
    });

    clearTimeout(fetchTimer);

    if (!imgResponse.ok) {
      throw new Error(`Server upstream mengembalikan status ${imgResponse.status}`);
    }

    const buffer = Buffer.from(await imgResponse.arrayBuffer());

    if (buffer.length > MAX_FILE_SIZE_MB * 1024 * 1024) {
      res.status(400).json({ success: false, message: 'File terlalu besar untuk diproses.' });
      return;
    }

    const upstreamContentType = imgResponse.headers.get('content-type') || 'image/jpeg';
    let fileExt = 'jpg';
    if (upstreamContentType.includes('webp')) fileExt = 'webp';
    else if (upstreamContentType.includes('png')) fileExt = 'png';

    const indexSuffix = typeof itemIndex === 'number' ? `_${itemIndex + 1}` : '';
    const safeFilename = sanitizeFilename(`LinkDrop_Instagram_Photo${indexSuffix}`, fileExt);

    res.setHeader('Content-Type', upstreamContentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('[Download Image Error]:', errorMsg);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Foto Instagram ini tidak dapat diproses saat ini.' });
    }
  }
});

setInterval(() => {
  try {
    const now = Date.now();
    const files = fs.readdirSync(TEMP_DIR);
    for (const file of files) {
      const fullPath = path.join(TEMP_DIR, file);
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs > 15 * 60 * 1000) {
        fs.unlinkSync(fullPath);
      }
    }
  } catch {}
}, 10 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`[LinkDrop Server] Berjalan pada port ${PORT}`);
  console.log(`[LinkDrop Server] Temp directory: ${TEMP_DIR}`);
});
