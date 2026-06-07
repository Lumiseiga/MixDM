/**
 * MIXDM â€” yt-dlp Engine
 * Wraps yt-dlp.exe to download YouTube, Twitter, Facebook,
 * Instagram, TikTok, and 1000+ other sites.
 */

const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { resourcePath } = require('./app-paths');

const BIN_DIR = resourcePath('bin');
const YTDLP_BIN = resourcePath('bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const FFMPEG_BIN = resourcePath('bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads', 'MIXDM');
const YTDLP_STABILITY_ARGS = [
  '--concurrent-fragments', '16',
  '--buffer-size', '1M',
  '--retries', '10',
  '--fragment-retries', '15',
  '--file-access-retries', '5',
  '--socket-timeout', '30',
];

const DEFAULT_VIDEO_FORMAT = 'bv*+ba/b';
const INFO_VIDEO_FORMAT = 'best/bv*+ba/b';
const AUDIO_ORIGINAL_FORMAT = 'mixdm:audio:original';
const MP3_320_FORMAT = 'mixdm:audio:mp3:320';
const MP3_256_FORMAT = 'mixdm:audio:mp3:256';
const MP3_192_FORMAT = 'mixdm:audio:mp3:192';

function normalizeExtractorArg(value) {
  const text = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  return text || null;
}

function buildExtractorArgs(opts = {}) {
  const raw = opts.extractorArgs || opts.ytdlpExtractorArgs;
  if (Array.isArray(raw)) {
    return raw.map(normalizeExtractorArg).filter(Boolean).flatMap(value => ['--extractor-args', value]);
  }
  const value = normalizeExtractorArg(raw);
  return value ? ['--extractor-args', value] : [];
}

function formatExtractorArgForLog(opts = {}) {
  const raw = opts.extractorArgs || opts.ytdlpExtractorArgs;
  if (Array.isArray(raw)) {
    return raw.map(normalizeExtractorArg).filter(Boolean).join(' | ');
  }
  return normalizeExtractorArg(raw) || 'default';
}

function getAudioMode(format) {
  if (format === AUDIO_ORIGINAL_FORMAT) {
    return { type: 'original' };
  }
  const mp3Match = String(format || '').match(/^mixdm:audio:mp3:(192|256|320)$/);
  if (mp3Match) {
    return { type: 'mp3', bitrate: mp3Match[1] };
  }
  return null;
}

function isAudioOnlyFormat(format) {
  return !!getAudioMode(format) || format === 'bestaudio/best';
}

function normalizeYtdlpFormat(format) {
  const value = String(format || '').trim();
  if (!value) return DEFAULT_VIDEO_FORMAT;
  if (getAudioMode(value) || value === 'bestaudio/best') return value;

  if (value === 'bestvideo+bestaudio[ext=m4a]/bestvideo+bestaudio/best' ||
      value === 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best') {
    return DEFAULT_VIDEO_FORMAT;
  }

  const resolutionMatch = value.match(/\[(?:height|width)<=([0-9]+)\]/);
  if (resolutionMatch) {
    const limit = resolutionMatch[1];
    return `bv*[height<=${limit}]+ba/b[height<=${limit}]/bv*[height<=${limit}]/b`;
  }

  return value;
}

function getYtdlpPlaceholderExt(format) {
  const audioMode = getAudioMode(format);
  if (audioMode?.type === 'mp3') return 'mp3';
  if (audioMode?.type === 'original' || format === 'bestaudio/best') return 'audio';
  return 'mp4';
}

function normalizeYtdlpUrl(rawUrl) {
  const input = String(rawUrl || '').trim().replace(/^<|>$/g, '');
  if (!input) return input;

  try {
    const parsed = new URL(input);
    if (!['http:', 'https:'].includes(parsed.protocol)) return input;

    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const youtubeHosts = new Set([
      'youtube.com',
      'm.youtube.com',
      'music.youtube.com',
      'youtube-nocookie.com',
      'youtu.be'
    ]);

    if (youtubeHosts.has(host)) {
      let videoId = null;

      if (host === 'youtu.be') {
        videoId = parsed.pathname.split('/').filter(Boolean)[0] || null;
      } else if (parsed.pathname === '/watch') {
        videoId = parsed.searchParams.get('v');
      } else {
        const match = parsed.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/i);
        if (match) videoId = match[1];
      }

      if (videoId) {
        const clean = new URL('https://www.youtube.com/watch');
        clean.searchParams.set('v', videoId);
        const time = parsed.searchParams.get('t') || parsed.searchParams.get('start');
        if (time) clean.searchParams.set('t', time);
        return clean.href;
      }

      parsed.hostname = 'www.youtube.com';
      ['si', 'feature', 'app', 'pp', 'fbclid'].forEach(key => parsed.searchParams.delete(key));
      return parsed.href;
    }

    return input;
  } catch {
    return input;
  }
}

// â”€â”€â”€ URL Detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const SOCIAL_PATTERNS = [
  // YouTube
  /(?:youtube\.com\/(?:watch|shorts|live|embed|v|clip)|youtu\.be\/)/i,
  // Twitter/X
  /(?:twitter\.com|x\.com)\/\w+\/status\//i,
  // Facebook
  /(?:facebook\.com|fb\.watch|fb\.me)/i,
  // Instagram
  /instagram\.com\/(?:p|reel|tv)\//i,
  // TikTok
  /tiktok\.com\/@[\w.]+\/video\//i,
  /vm\.tiktok\.com\//i,
  // Reddit
  /reddit\.com\/r\/\w+\/comments\//i,
  // Twitch
  /twitch\.tv\/(?:videos\/|clips\/|\w+\/clip\/)/i,
  // Vimeo
  /vimeo\.com\/\d+/i,
  // Dailymotion
  /dailymotion\.com\/video\//i,
  // Bilibili
  /(?:bilibili\.com|bilibili\.tv)/i,
  // Niconico
  /nicovideo\.jp\/watch\//i,
  // SoundCloud
  /soundcloud\.com\/[\w-]+\/[\w-]+/i,
];

/**
 * Returns true if the URL should be handled by yt-dlp
 */
function isYtdlpUrl(url) {
  try {
    const normalizedUrl = normalizeYtdlpUrl(url);
    const u = new URL(normalizedUrl);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    
    // Direct HLS (.m3u8) or DASH (.mpd) stream links should use yt-dlp
    if (/\.(m3u8|mpd)(?:\?|$)/i.test(u.pathname)) return true;
    
    return SOCIAL_PATTERNS.some(pattern => pattern.test(normalizedUrl));
  } catch {
    return false;
  }
}

/**
 * Detect the platform name from URL for display
 */
function detectPlatform(url) {
  url = normalizeYtdlpUrl(url);
  if (/youtu/i.test(url)) return 'YouTube';
  if (/twitter\.com|x\.com/i.test(url)) return 'Twitter/X';
  if (/facebook|fb\./i.test(url)) return 'Facebook';
  if (/instagram/i.test(url)) return 'Instagram';
  if (/tiktok/i.test(url)) return 'TikTok';
  if (/reddit/i.test(url)) return 'Reddit';
  if (/twitch/i.test(url)) return 'Twitch';
  if (/vimeo/i.test(url)) return 'Vimeo';
  if (/dailymotion/i.test(url)) return 'Dailymotion';
  if (/bilibili/i.test(url)) return 'Bilibili';
  if (/soundcloud/i.test(url)) return 'SoundCloud';
  return 'Social Media';
}

// â”€â”€â”€ Check yt-dlp binary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function isYtdlpInstalled() {
  return fs.existsSync(YTDLP_BIN);
}

function isFfmpegInstalled() {
  return fs.existsSync(FFMPEG_BIN);
}

function normalizeYtdlpErrorMessage(err) {
  return String(err && err.message ? err.message : err || '').toLowerCase();
}

function isBrowserCookieReadError(err) {
  const msg = normalizeYtdlpErrorMessage(err);
  return msg.includes('permissiondenied') ||
    msg.includes('permission denied') ||
    msg.includes('resource busy') ||
    msg.includes('database is locked') ||
    msg.includes('database locked') ||
    msg.includes('could not copy') ||
    msg.includes('failed to decrypt') ||
    msg.includes('cannot decrypt') ||
    msg.includes('keyring') ||
    msg.includes('cookie database') ||
    msg.includes('unable to open database file');
}

function isYtdlpAuthError(err) {
  const msg = normalizeYtdlpErrorMessage(err);
  return msg.includes('sign in') ||
    msg.includes('login') ||
    msg.includes('confirm your identity') ||
    msg.includes('confirm your age') ||
    msg.includes('not a bot') ||
    msg.includes('use --cookies') ||
    msg.includes('cookies-from-browser') ||
    msg.includes('private') ||
    msg.includes('members-only') ||
    msg.includes('age-restricted');
}

function isYtdlpFormatUnavailableError(err) {
  const msg = normalizeYtdlpErrorMessage(err);
  return msg.includes('requested format is not available') ||
    msg.includes('use --list-formats');
}

function normalizeCookieHeader(cookiesHeader) {
  const value = String(cookiesHeader || '').trim();
  if (!value) return '';
  return value.replace(/[\r\n]+/g, ' ').replace(/^cookie:\s*/i, '').trim();
}

function safeCookieField(value) {
  return String(value ?? '').replace(/[\t\r\n]/g, ' ').trim();
}

function parseCookieHeader(cookiesHeader, url) {
  const header = normalizeCookieHeader(cookiesHeader);
  if (!header) return [];

  let host = 'localhost';
  try {
    host = new URL(normalizeYtdlpUrl(url)).hostname.toLowerCase();
  } catch (_) {}

  const domains = host.endsWith('youtube.com')
    ? ['.youtube.com', host]
    : [host];

  const pairs = header.split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const eq = part.indexOf('=');
      if (eq <= 0) return null;
      return { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() };
    })
    .filter(pair => pair && pair.name);

  const cookies = [];
  for (const domain of domains) {
    for (const pair of pairs) {
      cookies.push({
        domain,
        hostOnly: !domain.startsWith('.'),
        path: '/',
        secure: true,
        expirationDate: Math.floor(Date.now() / 1000) + 86400 * 30,
        name: pair.name,
        value: pair.value,
      });
    }
  }
  return cookies;
}

function normalizeCookieObjects(cookies) {
  if (!Array.isArray(cookies)) return [];
  const result = [];
  const seen = new Set();

  for (const cookie of cookies) {
    if (!cookie || !cookie.name) continue;
    const name = safeCookieField(cookie.name);
    const value = safeCookieField(cookie.value);
    const domain = safeCookieField(cookie.domain || '');
    if (!name || !domain) continue;

    const pathValue = safeCookieField(cookie.path || '/');
    const key = `${domain}\t${pathValue}\t${name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const expirationDate = Number(cookie.expirationDate);
    result.push({
      domain,
      hostOnly: cookie.hostOnly === true,
      path: pathValue || '/',
      secure: cookie.secure !== false,
      expirationDate: Number.isFinite(expirationDate) && expirationDate > 0
        ? Math.floor(expirationDate)
        : Math.floor(Date.now() / 1000) + 86400 * 30,
      name,
      value,
    });
  }

  return result;
}

function writeTempCookiesFile(cookies) {
  const normalized = normalizeCookieObjects(cookies);
  if (normalized.length === 0) return null;

  const dir = path.join(os.tmpdir(), 'MIXDM', 'yt-dlp-cookies');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `cookies-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  const lines = [
    '# Netscape HTTP Cookie File',
    '# Generated by MIXDM. This file is temporary.',
    ''
  ];

  for (const cookie of normalized) {
    const includeSubdomains = cookie.hostOnly ? 'FALSE' : 'TRUE';
    const expires = cookie.expirationDate > 0
      ? cookie.expirationDate
      : Math.floor(Date.now() / 1000) + 86400 * 30;
    lines.push([
      cookie.domain,
      includeSubdomains,
      cookie.path || '/',
      cookie.secure ? 'TRUE' : 'FALSE',
      expires,
      cookie.name,
      cookie.value,
    ].join('\t'));
  }

  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
}

function buildCookieArgs(opts = {}, url) {
  if (opts.noCookies || opts.disableCookies) {
    return { args: [], source: 'disabled', count: 0, cleanup: () => {} };
  }

  if (opts.cookiesFile && fs.existsSync(opts.cookiesFile)) {
    return { args: ['--cookies', opts.cookiesFile], source: 'cookies-file', count: 0, cleanup: () => {} };
  }

  const cookies = normalizeCookieObjects(opts.cookies);
  const headerCookies = cookies.length ? [] : parseCookieHeader(opts.cookiesHeader, url);
  const cookieFile = writeTempCookiesFile(cookies.length ? cookies : headerCookies);
  if (!cookieFile) return { args: [], source: opts.cookiesBrowser ? 'browser' : 'none', count: 0, cleanup: () => {} };

  return {
    args: ['--cookies', cookieFile],
    source: cookies.length ? 'extension-cookies' : 'custom-cookie-header',
    count: cookies.length || headerCookies.length,
    cleanup: () => {
      try { fs.unlinkSync(cookieFile); } catch (_) {}
    }
  };
}


// â”€â”€â”€ Analyze URL with yt-dlp â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Run yt-dlp --dump-json to get video metadata
 * Returns { title, thumbnail, duration, uploader, formats, bestFormat, platform }
 */
function analyzeYtdlp(url, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!isYtdlpInstalled()) {
      return reject(new Error('yt-dlp.exe not found. Please restart the server to auto-install.'));
    }

    const normalizedUrl = normalizeYtdlpUrl(url);

    const args = [
      '--ignore-config',
      '--dump-json',
      '--no-playlist',
      '--no-warnings',
    ];

    const selectedFormat = opts.format ? normalizeYtdlpFormat(opts.format) : null;
    if (selectedFormat) {
      args.push('--format', selectedFormat);
    }
    args.push(...buildExtractorArgs(opts));

    const cookieArgs = buildCookieArgs(opts, normalizedUrl);
    args.push(...cookieArgs.args);
    if (cookieArgs.args.length === 0 && opts.cookiesBrowser) {
      args.push('--cookies-from-browser', opts.cookiesBrowser);
    }
    console.log(`[yt-dlp] analyze ${normalizedUrl} format=${selectedFormat || 'auto'} extractorArgs=${formatExtractorArgForLog(opts)} cookieSource=${cookieArgs.source}${cookieArgs.count ? ` cookies=${cookieArgs.count}` : opts.cookiesBrowser ? ` browser=${opts.cookiesBrowser}` : ''}`);

    args.push(normalizedUrl);


    const proc = spawn(YTDLP_BIN, args);
    let stdout = '';
    let stderr = '';
    let settled = false;

    // Timeout: 45 seconds
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { proc.kill(); } catch (_) {}
        cookieArgs.cleanup();
        reject(new Error('Analyze timed out after 45 seconds'));
      }
    }, 45000);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      cookieArgs.cleanup();
      if (settled) return;
      settled = true;

      if (code !== 0) {
        // Extract the most meaningful error line from stderr
        const lines = stderr.split('\n').map(l => l.trim()).filter(Boolean);
        const errLine = lines.find(l => l.includes('ERROR:')) ||
                        lines.find(l => l.includes('error')) ||
                        lines[lines.length - 1] || `yt-dlp exited with code ${code}`;
        console.warn(`[yt-dlp] analyze failed code=${code}: ${errLine}`);
        // Remove "ERROR: " prefix for cleaner display
        return reject(new Error(errLine.replace(/^ERROR:\s*/i, '')));
      }

      try {
        // yt-dlp may output multiple JSON lines for playlists; take the last valid one
        const jsonLines = stdout.trim().split('\n').filter(l => l.startsWith('{'));
        const info = JSON.parse(jsonLines[jsonLines.length - 1]);

        const rawFormats = info.formats || [];
        const formats = buildFormatList(rawFormats, info.ext, info.duration);

        resolve({
          title: info.title || 'Unknown Title',
          thumbnail: info.thumbnail || null,
          duration: info.duration || 0,
          uploader: info.uploader || info.channel || info.uploader_id || '',
          platform: detectPlatform(normalizedUrl),
          formats,
          ext: info.ext || 'mp4',
          webpage_url: info.webpage_url || normalizedUrl,
          normalizedUrl,
          id: info.id || '',
        });
      } catch (e) {
        reject(new Error('Failed to parse yt-dlp metadata: ' + e.message));
      }
    });

    proc.on('error', (e) => {
      clearTimeout(timer);
      cookieArgs.cleanup();
      reject(new Error('Failed to start yt-dlp: ' + e.message));
    });
  });
}

/**
 * Helper to format bytes to human readable string (server side)
 */
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < sizes.length - 1) {
    n /= 1024;
    i++;
  }
  return `~${n.toFixed(i === 0 ? 0 : 1)} ${sizes[i]}`;
}

/**
 * Helper to approximate MP3 size based on duration and bitrate
 */
function approxMp3Size(durationSec, bitrateKbps) {
  if (!durationSec || durationSec <= 0) return 0;
  return Math.round(durationSec * (bitrateKbps * 1000 / 8));
}

/**
 * Build a dynamic format list from actual video formats detected by yt-dlp.
 * Shows every real resolution that the video actually has (4K, 1440p, 1080p, etc.)
 */
function buildFormatList(rawFormats, defaultExt, duration = 0) {
  const result = [];

  // â”€â”€ 1. Collect unique resolution classes (min of width and height) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const resSet = new Set();
  for (const f of rawFormats) {
    if (f.vcodec && f.vcodec !== 'none') {
      const w = f.width || 0;
      const h = f.height || 0;
      const r = (w > 0 && h > 0) ? Math.min(w, h) : (h || w || 0);
      if (r > 0) {
        resSet.add(r);
      }
    }
  }

  // Sort descending (highest quality first)
  const resolutions = [...resSet].sort((a, b) => b - a);

  // â”€â”€ 2. Check if separate audio streams exist (for ffmpeg merge) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const hasSeperateAudio = rawFormats.some(
    f => f.acodec && f.acodec !== 'none' && f.vcodec === 'none'
  );

  // Some platforms (Twitter/X, TikTok) bundle audio+video in a single stream
  const hasCombinedStream = rawFormats.some(
    f => f.acodec && f.acodec !== 'none' && f.vcodec && f.vcodec !== 'none'
  );

  // â”€â”€ 3. Find best audio size (for merging size calculation) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let bestAudioSize = 0;
  for (const f of rawFormats) {
    if (f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')) {
      const sz = f.filesize || f.filesize_approx || 0;
      if (sz > bestAudioSize) bestAudioSize = sz;
    }
  }

  // â”€â”€ 4. Friendly label mapping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const heightLabels = {
    2160: '4K (2160p)',
    1440: '2K (1440p)',
    1080: '1080p (Full HD)',
    720:  '720p (HD)',
    480:  '480p',
    360:  '360p',
    270:  '270p (Low)',
    240:  '240p (Low)',
    144:  '144p (Lowest)',
  };

  // â”€â”€ 5. Calculate "Best Quality" size â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let bestQualitySize = 0;
  if (resolutions.length > 0) {
    const r = resolutions[0];
    if (hasSeperateAudio) {
      let bestVideoSize = 0;
      for (const f of rawFormats) {
        const w = f.width || 0;
        const h = f.height || 0;
        const res = (w > 0 && h > 0) ? Math.min(w, h) : (h || w || 0);
        if (res === r && f.vcodec && f.vcodec !== 'none') {
          const sz = f.filesize || f.filesize_approx || 0;
          if (sz > bestVideoSize) bestVideoSize = sz;
        }
      }
      bestQualitySize = bestVideoSize > 0 ? (bestVideoSize + bestAudioSize) : 0;
    } else {
      for (const f of rawFormats) {
        const w = f.width || 0;
        const h = f.height || 0;
        const res = (w > 0 && h > 0) ? Math.min(w, h) : (h || w || 0);
        if (res === r) {
          const sz = f.filesize || f.filesize_approx || 0;
          if (sz > bestQualitySize) bestQualitySize = sz;
        }
      }
    }
  }

  // â”€â”€ 6. "Best" option always at the top â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const bestQualitySizeStr = formatBytes(bestQualitySize);
  result.push({
    label: `Best Quality${resolutions.length > 0 ? ` (up to ${heightLabels[resolutions[0]] || resolutions[0] + 'p'}${bestQualitySizeStr ? ` - ${bestQualitySizeStr}` : ''})` : ''}`,
    value: DEFAULT_VIDEO_FORMAT,
    ext: 'mp4',
    isBest: true,
    size: bestQualitySize,
  });

  // â”€â”€ 7. Per-resolution options â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  for (const r of resolutions) {
    // Skip very low resolutions if there are better ones (avoid clutter)
    // But always include if it's one of the only options
    if (resolutions.length > 4 && r < 360) continue;

    // Calculate estimated size for this resolution
    let estimatedSize = 0;
    if (hasSeperateAudio) {
      let bestVideoSize = 0;
      for (const f of rawFormats) {
        const w = f.width || 0;
        const h = f.height || 0;
        const res = (w > 0 && h > 0) ? Math.min(w, h) : (h || w || 0);
        if (res === r && f.vcodec && f.vcodec !== 'none') {
          const sz = f.filesize || f.filesize_approx || 0;
          if (sz > bestVideoSize) bestVideoSize = sz;
        }
      }
      estimatedSize = bestVideoSize > 0 ? (bestVideoSize + bestAudioSize) : 0;
    } else {
      for (const f of rawFormats) {
        const w = f.width || 0;
        const h = f.height || 0;
        const res = (w > 0 && h > 0) ? Math.min(w, h) : (h || w || 0);
        if (res === r) {
          const sz = f.filesize || f.filesize_approx || 0;
          if (sz > estimatedSize) estimatedSize = sz;
        }
      }
    }

    const sizeStr = formatBytes(estimatedSize);
    const label = `${heightLabels[r] || r + 'p'}${sizeStr ? ` (${sizeStr})` : ''}`;

    // For platforms with combined audio+video (Twitter, TikTok):
    // use format selector that picks the best stream at this resolution
    // For platforms with separate video+audio (YouTube):
    // merge best video at this resolution with best audio
    // Supports both landscape (height-based) and vertical (width-based) streams
    let formatValue;
    if (hasSeperateAudio) {
      formatValue = `bv*[height<=${r}]+ba/b[height<=${r}]/bv*[height<=${r}]/b`;
    } else if (hasCombinedStream) {
      formatValue = `b[height<=${r}]/b[width<=${r}]/bv*[height<=${r}]/bv*[width<=${r}]/b`;
    } else {
      formatValue = `bv*[height<=${r}]+ba/b[height<=${r}]/bv*[height<=${r}]/b`;
    }

    result.push({ label, value: formatValue, ext: 'mp4', height: r, size: estimatedSize });
  }

  // â”€â”€ 8. Audio-only option â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const hasAudioStream = rawFormats.some(
    f => (f.acodec && f.acodec !== 'none') || f.audio_ext === 'mp3' || f.audio_ext === 'm4a'
  );
  if (hasAudioStream) {
    const originalAudioSizeStr = formatBytes(bestAudioSize);
    const mp3_320_sz = approxMp3Size(duration, 320);
    const mp3_256_sz = approxMp3Size(duration, 256);
    const mp3_192_sz = approxMp3Size(duration, 192);

    result.push(
      {
        label: `Audio Only - Best Original${originalAudioSizeStr ? ` (${originalAudioSizeStr})` : ''}`,
        value: AUDIO_ORIGINAL_FORMAT,
        ext: 'original',
        audioOnly: true,
        size: bestAudioSize,
      },
      {
        label: `MP3 320 kbps${mp3_320_sz > 0 ? ` (${formatBytes(mp3_320_sz)})` : ''}`,
        value: MP3_320_FORMAT,
        ext: 'mp3',
        audioOnly: true,
        size: mp3_320_sz,
      },
      {
        label: `MP3 256 kbps${mp3_256_sz > 0 ? ` (${formatBytes(mp3_256_sz)})` : ''}`,
        value: MP3_256_FORMAT,
        ext: 'mp3',
        audioOnly: true,
        size: mp3_256_sz,
      },
      {
        label: `MP3 192 kbps${mp3_192_sz > 0 ? ` (${formatBytes(mp3_192_sz)})` : ''}`,
        value: MP3_192_FORMAT,
        ext: 'mp3',
        audioOnly: true,
        size: mp3_192_sz,
      }
    );
  }

  // Fallback: if no formats detected, return safe defaults
  if (result.length === 1) {
    result.push({ label: '720p (HD)', value: 'bv*[height<=720]+ba/b[height<=720]/bv*[height<=720]/b', ext: 'mp4', size: 0 });
    result.push({ label: '480p',      value: 'bv*[height<=480]+ba/b[height<=480]/bv*[height<=480]/b', ext: 'mp4', size: 0 });
    result.push({ label: 'Audio Only - Best Original', value: AUDIO_ORIGINAL_FORMAT, ext: 'original', audioOnly: true, size: 0 });
    result.push({ label: 'MP3 320 kbps', value: MP3_320_FORMAT, ext: 'mp3', audioOnly: true, size: 0 });
    result.push({ label: 'MP3 256 kbps', value: MP3_256_FORMAT, ext: 'mp3', audioOnly: true, size: 0 });
    result.push({ label: 'MP3 192 kbps', value: MP3_192_FORMAT, ext: 'mp3', audioOnly: true, size: 0 });
  }

  return result;
}

// â”€â”€â”€ Download with yt-dlp â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Start a yt-dlp download.
 * @param {string} url
 * @param {object} opts - { format, outputTemplate }
 * @param {function} onProgress - called with { percent, speed, eta, status }
 * @param {function} onDone - called with { outputPath }
 * @param {function} onError - called with error
 * @returns {object} controller with .cancel()
 */
function downloadYtdlp(url, opts, onProgress, onDone, onError) {
  if (!isYtdlpInstalled()) {
    onError(new Error('yt-dlp.exe not found'));
    return { cancel: () => {} };
  }

  const normalizedUrl = normalizeYtdlpUrl(url);
  const selectedFormat = normalizeYtdlpFormat(opts.format || DEFAULT_VIDEO_FORMAT);
  const audioMode = getAudioMode(selectedFormat);
  const format = audioMode ? 'bestaudio/best' : selectedFormat;

  const downloadsDir = opts.downloadsDir || DOWNLOADS_DIR;
  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
  }

  // Safe output template â€” restrict filename length and strip problematic chars
  const outputTemplate = path.join(downloadsDir, '%(title).150B.%(ext)s');

    const args = [
    '--ignore-config',
    '--format', format,
    '--output', outputTemplate,
    '--no-playlist',
    '--newline',
    '--progress',
    '--no-warnings',
    '--encoding', 'utf-8',
    ...YTDLP_STABILITY_ARGS,
  ];
  args.push(...buildExtractorArgs(opts));

  const cookieArgs = buildCookieArgs(opts, normalizedUrl);
  args.push(...cookieArgs.args);
  if (cookieArgs.args.length === 0 && opts.cookiesBrowser) {
    args.push('--cookies-from-browser', opts.cookiesBrowser);
  }
  console.log(`[yt-dlp] download ${normalizedUrl} format=${format} extractorArgs=${formatExtractorArgForLog(opts)} cookieSource=${cookieArgs.source}${cookieArgs.count ? ` cookies=${cookieArgs.count}` : opts.cookiesBrowser ? ` browser=${opts.cookiesBrowser}` : ''}`);

  // Speed limit support: --limit-rate accepts e.g. "5120K" (KB/s)
  if (opts.speedLimitKbps && opts.speedLimitKbps > 0) {
    args.push('--limit-rate', `${Math.round(opts.speedLimitKbps)}K`);
  }

  if (audioMode && audioMode.type === 'mp3') {
    args.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', `${audioMode.bitrate}K`);
  } else if (!audioMode) {
    args.push('--merge-output-format', 'mp4');
  }

  // Add ffmpeg location if we have it (required for merging video+audio)
  if (isFfmpegInstalled()) {
    args.push('--ffmpeg-location', BIN_DIR);
  }

  args.push(normalizedUrl);

  const proc = spawn(YTDLP_BIN, args, {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
  });

  let cancelled = false;
  let outputPath = null;
  let lastFilename = null;
  let stderrLines = [];

  // â”€â”€ Parse stdout (progress + destination lines) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  proc.stdout.on('data', (data) => {
    const lines = data.toString('utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Progress: [download]  42.1% of  123.45MiB at   5.23MiB/s ETA 00:30
      // Match size loosely until " at " to handle "~ 1.50 GiB"
      const progressMatch = trimmed.match(
        /\[download\]\s+([\d.]+)%\s+of\s+(.+?)\s+at\s+([\d.]+\s*\S+\/s)\s+ETA\s+(\S+)/
      );
      if (progressMatch) {
        const [, pct, total, speed, eta] = progressMatch;
        onProgress({
          status: 'downloading',
          percent: Math.min(parseFloat(pct), 100),
          totalStr: total,
          fileSize: parseSizeStr(total),
          speedStr: speed,
          etaStr: eta,
        });
        continue;
      }

      // Destination file
      const destMatch = trimmed.match(/\[download\] Destination:\s+(.+)$/);
      if (destMatch) {
        lastFilename = destMatch[1].trim();
        onProgress({ status: 'downloading', filename: path.basename(lastFilename) });
        continue;
      }

      const extractAudioMatch = trimmed.match(/\[ExtractAudio\] Destination:\s+(.+)$/);
      if (extractAudioMatch) {
        outputPath = extractAudioMatch[1].trim();
        onProgress({ status: 'merging', filename: path.basename(outputPath) });
        continue;
      }

      // ffmpeg merge phase: "Merging formats into "path.mp4""
      const mergeMatch = trimmed.match(/Merging formats into "(.+)"/);
      if (mergeMatch) {
        outputPath = mergeMatch[1].trim();
        onProgress({ status: 'merging' });
        continue;
      }

      // Other merge/ffmpeg indicators
      if (trimmed.includes('[Merger]') || trimmed.includes('[ffmpeg]') ||
          trimmed.includes('[VideoRemuxer]') || trimmed.includes('Merging')) {
        onProgress({ status: 'merging' });
        continue;
      }

      // Already downloaded
      if (trimmed.includes('has already been downloaded')) {
        const m = trimmed.match(/\[download\] (.+) has already been downloaded/);
        if (m) lastFilename = m[1].trim();
        onProgress({ status: 'done', percent: 100 });
        continue;
      }

      // HLS download progress (different format: fragment x/y)
      const hlsMatch = trimmed.match(/\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\S+)/);
      if (hlsMatch) {
        const [, pct, total] = hlsMatch;
        onProgress({
          status: 'downloading',
          percent: Math.min(parseFloat(pct), 100),
          totalStr: total,
          fileSize: parseSizeStr(total),
        });
        continue;
      }
    }
  });

  // â”€â”€ Collect stderr for error reporting â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  proc.stderr.on('data', (data) => {
    const lines = data.toString('utf8').split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      stderrLines.push(line);
      if (line.includes('ERROR:')) {
        console.error('[yt-dlp]', line);
      }
    }
  });

  proc.on('close', (code) => {
    cookieArgs.cleanup();
    if (cancelled) return;
    if (code === 0) {
      const finalPath = outputPath || lastFilename || DOWNLOADS_DIR;
      onDone({ outputPath: finalPath });
    } else {
      // Extract a human-readable error
      const errLine = stderrLines.find(l => l.includes('ERROR:')) ||
                      stderrLines[stderrLines.length - 1] ||
                      `yt-dlp failed (exit code ${code})`;
      onError(new Error(errLine.replace(/^ERROR:\s*/i, '')));
    }
  });

  proc.on('error', (err) => {
    cookieArgs.cleanup();
    onError(new Error('Failed to launch yt-dlp: ' + err.message));
  });

  return {
    cancel() {
      cancelled = true;
      cookieArgs.cleanup();
      try {
        if (os.platform() === 'win32') {
          // Force kill process tree on Windows to ensure ffmpeg and yt-dlp stop completely
          exec(`taskkill /pid ${proc.pid} /f /t`, (err) => {
            if (err) console.error('Failed to taskkill:', err);
          });
        } else {
          proc.kill('SIGKILL');
        }
      } catch (_) {
        try { proc.kill(); } catch (__) {}
      }
    }
  };
}

// â”€â”€â”€ Speed string parser (yt-dlp format â†’ bytes/s) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function parseSpeedStr(speedStr) {
  if (!speedStr) return 0;
  const m = speedStr.match(/([\d.]+)\s*([KMGT]?)iB\/s/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const u = { '': 1, 'K': 1024, 'M': 1048576, 'G': 1073741824, 'T': 1099511627776 };
  return Math.round(n * (u[m[2].toUpperCase()] || 1));
}

// â”€â”€â”€ Size string parser (yt-dlp format â†’ bytes) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function parseSizeStr(sizeStr) {
  if (!sizeStr) return 0;
  const clean = sizeStr.replace('~', '').trim();
  const m = clean.match(/([\d.]+)\s*([KMGT]?)i?B/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const u = { '': 1, 'K': 1024, 'M': 1048576, 'G': 1073741824, 'T': 1099511627776 };
  return Math.round(n * (u[m[2].toUpperCase()] || 1));
}

function parseEtaStr(etaStr) {
  if (!etaStr || etaStr === 'Unknown') return null;
  const parts = etaStr.split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

module.exports = {
  isYtdlpUrl,
  detectPlatform,
  normalizeYtdlpUrl,
  isYtdlpInstalled,
  isFfmpegInstalled,
  analyzeYtdlp,
  downloadYtdlp,
  parseSpeedStr,
  parseSizeStr,
  parseEtaStr,
  isBrowserCookieReadError,
  isYtdlpAuthError,
  isYtdlpFormatUnavailableError,
  isAudioOnlyFormat,
  normalizeYtdlpFormat,
  getYtdlpPlaceholderExt,
  YTDLP_BIN,
  FFMPEG_BIN,
  BIN_DIR,
};

