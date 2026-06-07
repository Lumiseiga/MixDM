const path = require('path');
const { URL } = require('url');

// List of highly trusted video/social/system platforms
const TRUSTED_DOMAINS = [
  'youtube.com', 'youtu.be', 'www.youtube.com',
  'facebook.com', 'fb.watch', 'fb.me', 'www.facebook.com', 'm.facebook.com',
  'twitter.com', 'x.com', 'www.twitter.com', 'www.x.com',
  'instagram.com', 'www.instagram.com',
  'tiktok.com', 'vm.tiktok.com', 'www.tiktok.com',
  'twitch.tv', 'www.twitch.tv',
  'vimeo.com', 'www.vimeo.com',
  'dailymotion.com', 'www.dailymotion.com',
  'bilibili.com', 'bilibili.tv', 'www.bilibili.com',
  'soundcloud.com', 'www.soundcloud.com',
  'github.com', 'www.github.com',
  'microsoft.com', 'www.microsoft.com',
  'google.com', 'www.google.com',
  'apple.com', 'www.apple.com'
];

// Dangerous file extensions that are executable/scriptable
const DANGEROUS_EXTS = [
  '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.pif',
  '.vbs', '.js', '.vbe', '.jse', '.wsf', '.wsh', '.ps1',
  '.jar', '.apk', '.dmg', '.pkg', '.app'
];

// Standard safe media/document/archive extensions
const SAFE_EXTS = [
  '.mp4', '.mkv', '.webm', '.flv', '.mov', '.avi', '.ts', '.m3u8', '.mpd', // Video
  '.mp3', '.m4a', '.wav', '.flac', '.ogg', '.aac', // Audio
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', // Images
  '.zip', '.rar', '.7z', '.tar', '.gz', // Archives
  '.pdf', '.epub', '.txt', '.doc', '.docx' // Documents
];

// ─── Regex helpers ────────────────────────────────────────────────────────────

// Matches bare IPv4 addresses used as hostname (e.g. 192.168.1.1)
const IP_HOSTNAME_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

// Unicode confusable characters (Cyrillic, Greek, etc.) that look like ASCII
// These are used in homoglyph/spoofing attacks in filenames
const UNICODE_CONFUSABLES_RE = /[\u0430\u0435\u043e\u0440\u0441\u0443\u0445\u0446\u03b1\u03b2\u03b5\u03b7\u03b9\u03ba\u03bd\u03bf\u03c1\u03c3\u03c5]/i;

/**
 * Check if a download is potentially unsafe based on:
 * - File extension (dangerous executables)
 * - URL domain trust (known safe vs unknown)
 * - Protocol (HTTP vs HTTPS)
 * - IP-address hostnames
 * - Double extensions (e.g. video.mp4.exe)
 * - Unicode homoglyph spoofing in filenames
 *
 * @param {string} url
 * @param {string} filename
 * @returns {{ safe: boolean, warning?: boolean, reason: string, message: string }}
 */
function checkSafety(url, filename) {
  if (!url) return { safe: true };

  let parsed;
  let domain = '';
  let protocol = '';
  try {
    parsed = new URL(url);
    domain = parsed.hostname.toLowerCase();
    protocol = parsed.protocol; // 'http:' or 'https:'
  } catch (_) {
    return { safe: false, reason: 'invalid-url', message: 'ที่อยู่ลิงก์ไม่ถูกต้อง' };
  }

  // Check if domain is trusted
  const isTrustedDomain = TRUSTED_DOMAINS.some(d => domain === d || domain.endsWith('.' + d));

  // Determine file extension from filename or URL pathname
  const checkName = filename || '';
  let ext = '';
  if (checkName) {
    ext = path.extname(checkName).toLowerCase();
  } else {
    try {
      const pathname = new URL(url).pathname;
      ext = path.extname(pathname.split('?')[0]).toLowerCase();
    } catch (_) {}
  }

  // ── Check 1: Dangerous extension from untrusted domain ──────────────────────
  if (DANGEROUS_EXTS.includes(ext) && !isTrustedDomain) {
    return {
      safe: false,
      reason: 'dangerous-extension',
      message: `ไฟล์นี้มีนามสกุลที่สามารถรันโปรแกรมได้ (${ext}) และถูกดาวน์โหลดจากเว็บไซต์ภายนอกที่ไม่ได้รับรองความปลอดภัย (${domain}) ซึ่งอาจมีไวรัสหรือมัลแวร์แฝงอยู่`
    };
  }

  // ── Check 2: Double extension (e.g. video.mp4.exe) ──────────────────────────
  if (checkName) {
    const baseName = path.basename(checkName, ext); // strip last extension
    const innerExt = path.extname(baseName).toLowerCase();
    if (innerExt && DANGEROUS_EXTS.includes(ext) && SAFE_EXTS.includes(innerExt)) {
      return {
        safe: false,
        reason: 'double-extension',
        message: `ไฟล์นี้ใช้ชื่อหลอกลวง (double extension: ${innerExt}${ext}) ซึ่งเป็นวิธีที่มัลแวร์ใช้ปลอมตัวเป็นไฟล์สื่อ — ไม่แนะนำให้ดาวน์โหลด`
      };
    }
  }

  // ── Check 3: Unicode homoglyph spoofing in filename ─────────────────────────
  if (checkName && UNICODE_CONFUSABLES_RE.test(checkName)) {
    return {
      safe: false,
      reason: 'unicode-spoofing',
      message: `ชื่อไฟล์นี้ประกอบด้วยตัวอักษรที่ผิดปกติ (Unicode confusables) ซึ่งอาจใช้ปลอมชื่อไฟล์ให้ดูน่าเชื่อถือ — ควรระวัง`
    };
  }

  // ── Check 4: IP address hostname (not a named domain) ───────────────────────
  if (IP_HOSTNAME_RE.test(domain)) {
    return {
      safe: false,
      reason: 'ip-hostname',
      message: `ลิงก์นี้ชี้ไปยัง IP address (${domain}) โดยตรง แทนที่จะเป็นชื่อเว็บไซต์ ซึ่งเป็นพฤติกรรมที่พบบ่อยในการแจกจ่ายมัลแวร์`
    };
  }

  // ── Check 5: Non-standard extension from untrusted source ───────────────────
  const isSafeExt = SAFE_EXTS.includes(ext);
  if (!isTrustedDomain && !isSafeExt && ext !== '') {
    return {
      safe: false,
      reason: 'untrusted-source',
      message: `ไฟล์นี้ดาวน์โหลดจากเว็บไซต์ภายนอก (${domain}) และมีประเภทไฟล์ (${ext}) ที่ไม่ใช่ประเภทสื่อหรือเอกสารทั่วไป`
    };
  }

  // ── Warning: HTTP (not HTTPS) from untrusted domain ─────────────────────────
  if (protocol === 'http:' && !isTrustedDomain) {
    return {
      safe: true,   // Allow but warn
      warning: true,
      reason: 'http-not-https',
      message: `ลิงก์นี้ใช้ HTTP (ไม่เข้ารหัส) จากเว็บไซต์ภายนอก (${domain}) ข้อมูลที่รับส่งอาจถูกดักฟังได้ — ดาวน์โหลดได้แต่ควรระวัง`
    };
  }

  return { safe: true };
}

// ─── Filename Sanitizer ───────────────────────────────────────────────────────

/**
 * Sanitizes a filename to prevent directory traversal and remove illegal filesystem characters.
 * @param {string} filename - Raw filename from URL or user input
 * @returns {string} Safe filename (never empty — falls back to 'download')
 */
function sanitizeFilename(filename) {
  if (!filename || typeof filename !== 'string') return 'download';

  let safe = filename;

  // Decode percent-encoded traversal attempts before stripping
  try { safe = decodeURIComponent(safe); } catch (_) {}

  // Strip path traversal sequences (all variants)
  safe = safe.replace(/\.\.[/\\]/g, '');   // ../  ..\
  safe = safe.replace(/\.\.[/\\]?$/g, ''); // trailing ..
  safe = safe.replace(/^[/\\]+/, '');       // leading slashes

  // Remove directory separators entirely
  safe = safe.replace(/[/\\]/g, '_');

  // Remove characters illegal on Windows/Linux filesystems: < > : " | ? *  and control chars
  safe = safe.replace(/[<>:"|?*\x00-\x1f]/g, '');

  // Collapse multiple dots/underscores/spaces to single
  safe = safe.replace(/\.{2,}/g, '.').replace(/_{2,}/g, '_').replace(/\s{2,}/g, ' ').trim();

  // Limit length to 200 chars (preserve extension if present)
  if (safe.length > 200) {
    const ext = path.extname(safe);
    const base = path.basename(safe, ext).substring(0, 200 - ext.length);
    safe = base + ext;
  }

  // Final fallback if completely empty after stripping
  return safe || 'download';
}

module.exports = {
  checkSafety,
  sanitizeFilename,
  TRUSTED_DOMAINS,
  DANGEROUS_EXTS,
  SAFE_EXTS
};
