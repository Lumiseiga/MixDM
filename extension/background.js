const MIXDM_BASE = 'http://localhost:3737';
const APP_TAB_PATTERNS = [
  'http://localhost:3737/*',
  'http://127.0.0.1:3737/*'
];

const DEFAULT_FORMAT = 'bestvideo+bestaudio[ext=m4a]/bestvideo+bestaudio/best';
const ANALYZE_CACHE_TTL_MS = 10 * 60 * 1000;
const COOKIE_BRIDGE_MIN_INTERVAL_MS = 30 * 1000;
const analyzeCache = new Map();
const pendingAnalyze = new Map();
const cookieBridgeTimes = new Map();

function tabsQuery(query) {
  return new Promise(resolve => chrome.tabs.query(query, resolve));
}

function tabsUpdate(tabId, updateInfo) {
  return new Promise(resolve => chrome.tabs.update(tabId, updateInfo, resolve));
}

function tabsCreate(createProperties) {
  return new Promise(resolve => chrome.tabs.create(createProperties, resolve));
}

function windowsUpdate(windowId, updateInfo) {
  return new Promise(resolve => chrome.windows.update(windowId, updateInfo, resolve));
}

function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isYouTubeUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'youtu.be';
  } catch {
    return false;
  }
}

function cookiesGetAll(details) {
  return new Promise(resolve => {
    if (!chrome.cookies?.getAll) return resolve([]);
    chrome.cookies.getAll(details, cookies => resolve(cookies || []));
  });
}

async function getCookieHeaderForUrl(url) {
  const cookies = await getCookiesForUrl(url);
  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

async function getCookiesForUrl(url) {
  if (!isYouTubeUrl(url)) return [];

  const domains = [
    'youtube.com',
    'google.com',
    'accounts.google.com',
    'youtubei.googleapis.com',
    'googlevideo.com'
  ];
  const cookieMaps = await Promise.all([
    cookiesGetAll({ url: 'https://www.youtube.com/' }),
    cookiesGetAll({ url: 'https://music.youtube.com/' }),
    cookiesGetAll({ url }),
    ...domains.map(domain => cookiesGetAll({ domain }))
  ]);

  const byKey = new Map();
  cookieMaps.flat().forEach(cookie => {
    if (!cookie?.name) return;
    byKey.set(`${cookie.domain}|${cookie.path}|${cookie.name}`, cookie);
  });

  return [...byKey.values()]
    .sort((a, b) => (b.path || '').length - (a.path || '').length)
    .map(cookie => ({
      domain: cookie.domain,
      hostOnly: cookie.hostOnly,
      path: cookie.path || '/',
      secure: cookie.secure !== false,
      expirationDate: cookie.expirationDate || 0,
      name: cookie.name,
      value: cookie.value
    }));
}

async function bridgeCookiesForUrl(url, reason = 'auto') {
  const normalizedUrl = normalizePageUrl(url);
  if (!isYouTubeUrl(normalizedUrl)) return false;

  const lastAt = cookieBridgeTimes.get(normalizedUrl) || 0;
  if (Date.now() - lastAt < COOKIE_BRIDGE_MIN_INTERVAL_MS) return true;

  const cookies = await getCookiesForUrl(normalizedUrl);
  if (!cookies.length) return false;

  await fetchJson('/api/extension/cookies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: normalizedUrl, cookies, reason })
  });
  cookieBridgeTimes.set(normalizedUrl, Date.now());
  return true;
}

function normalizePageUrl(rawUrl) {
  if (!isHttpUrl(rawUrl)) return rawUrl;
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.replace(/^www\./, '');

  if ((host === 'youtube.com' || host === 'm.youtube.com') && parsed.pathname === '/watch') {
    const videoId = parsed.searchParams.get('v');
    if (videoId) {
      const clean = new URL('https://www.youtube.com/watch');
      clean.searchParams.set('v', videoId);
      const time = parsed.searchParams.get('t');
      if (time) clean.searchParams.set('t', time);
      return clean.href;
    }
  }

  if (host === 'youtu.be') {
    const videoId = parsed.pathname.split('/').filter(Boolean)[0];
    if (videoId) return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  }

  if ((host === 'youtube.com' || host === 'm.youtube.com') &&
      /^\/(shorts|live|embed|v)\//.test(parsed.pathname)) {
    const videoId = parsed.pathname.split('/').filter(Boolean)[1];
    if (videoId) return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    return `https://www.youtube.com${parsed.pathname}`;
  }

  if ((host === 'x.com' || host === 'twitter.com') && /\/status\//.test(parsed.pathname)) {
    return `https://${host}${parsed.pathname}`;
  }

  // Facebook: strip tracking params, keep core URL
  if (host === 'facebook.com' || host === 'fb.watch' || host === 'fb.me') {
    // fb.watch short links — keep as-is (yt-dlp resolves them)
    if (host === 'fb.watch' || host === 'fb.me') return rawUrl;
    // Strip fbclid and other tracking params
    const clean = new URL(rawUrl);
    clean.searchParams.delete('fbclid');
    clean.searchParams.delete('_nc_ht');
    clean.searchParams.delete('_nc_cat');
    return clean.href;
  }

  // Instagram: keep clean reel/post URL
  if (host === 'instagram.com') {
    const match = parsed.pathname.match(/^\/(p|reel|tv)\/([^/]+)/);
    if (match) return `https://www.instagram.com/${match[1]}/${match[2]}/`;
  }

  // TikTok short links and video URLs — keep as-is
  if (host === 'tiktok.com' || host === 'vm.tiktok.com') {
    return rawUrl;
  }

  return rawUrl;
}

function normalizeMediaUrl(rawUrl) {
  if (!isHttpUrl(rawUrl)) return rawUrl;
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.replace(/^www\./, '');

  // Twitter/X: always fetch full-res original
  if (host === 'pbs.twimg.com' && parsed.pathname.startsWith('/media/')) {
    parsed.searchParams.set('name', 'orig');
    return parsed.href;
  }

  return rawUrl;
}

/**
 * For some CDN hosts, the server enforces a specific Referer regardless of which
 * page the user is currently on. Return the required Referer, or null to fall back
 * to the page/tab URL.
 */
function getRequiredReferer(mediaUrl) {
  try {
    const { hostname } = new URL(mediaUrl);
    // Pixiv image CDN — must have https://www.pixiv.net/ as Referer
    if (hostname === 'i.pximg.net' || hostname === 'i-cf.pximg.net') {
      return 'https://www.pixiv.net/';
    }
    // ArtStation CDN
    if (hostname.endsWith('.artstation.com') && hostname !== 'www.artstation.com') {
      return 'https://www.artstation.com/';
    }
    // Weibo image CDN
    if (hostname.endsWith('.sinaimg.cn')) {
      return 'https://weibo.com/';
    }
    // DeviantArt CDN
    if (hostname.endsWith('.deviantart.net') || hostname.endsWith('.wixmp.com')) {
      return 'https://www.deviantart.com/';
    }
  } catch (_) {}
  return null;
}

function inferFilename(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    if (host === 'pbs.twimg.com' && parsed.pathname.startsWith('/media/')) {
      const id = parsed.pathname.split('/').filter(Boolean).pop() || 'twitter-image';
      const ext = parsed.searchParams.get('format') || 'jpg';
      return `${id}.${ext}`;
    }
  } catch {
    return '';
  }
  return '';
}

function titleFromTab(tab) {
  return (tab?.title || '')
    .replace(/\s+-\s+YouTube$/i, '')
    .replace(/\s+\/\s+X$/i, '')
    .replace(/\s+[|·-]\s+(?:Facebook|Instagram|TikTok|Reddit|Twitch|Vimeo|Dailymotion)$/i, '')
    .replace(/\s+on\s+(?:Facebook|Instagram|TikTok|Twitter|X)$/i, '')
    .trim();
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${MIXDM_BASE}${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `MIXDM returned HTTP ${response.status}`);
  }
  return data;
}

async function pingMixdm() {
  return fetchJson('/api/extension/status');
}

async function analyzeWithMixdm(payload) {
  const url = normalizePageUrl(payload.url);
  const cached = analyzeCache.get(url);
  if (cached && Date.now() - cached.time < ANALYZE_CACHE_TTL_MS) {
    return cached.info;
  }
  if (pendingAnalyze.has(url)) {
    return pendingAnalyze.get(url);
  }

  const cookies = await getCookiesForUrl(url);
  const request = fetchJson('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cookies.length ? { url, cookies } : { url })
  }).then(info => {
    analyzeCache.set(url, { info, time: Date.now() });
    pendingAnalyze.delete(url);
    return info;
  }).catch(err => {
    pendingAnalyze.delete(url);
    throw err;
  });

  pendingAnalyze.set(url, request);
  return request;
}

// Tell the Electron app to pop its window to the front.
// Falls back silently if the app is not running (standalone server mode).
async function focusMixdm() {
  try {
    await fetch(`${MIXDM_BASE}/api/focus-window`, { method: 'POST' });
  } catch (_) {
    // App not running or server-only mode — ignore
  }
}

async function openAnalyze(payload) {
  const url = normalizePageUrl(payload.url);
  try {
    await bridgeCookiesForUrl(url, 'open-analyze');
  } catch (err) {
    console.warn('[MIXDM] Could not bridge cookies to app:', err);
  }
  // Send the URL to the server so the app can open the analyze view
  try {
    await fetch(`${MIXDM_BASE}/api/focus-window`, { method: 'POST' });
  } catch (_) {}
  // Also open the web UI as a fallback if no Electron window is available
  const appTabs = await tabsQuery({ url: APP_TAB_PATTERNS });
  if (appTabs.length === 0) {
    // Only open a browser tab when truly no Electron window exists
    await tabsCreate({ url: `${MIXDM_BASE}/?url=${encodeURIComponent(url)}&action=analyze` });
  }
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  if (text) {
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1800);
  }
}

async function sendToMixdm(payload, options = {}) {
  const openApp = options.openApp !== false;
  const mediaUrl = payload.mediaKind === 'image' || payload.mediaKind === 'video' || payload.mediaKind === 'audio'
    ? normalizeMediaUrl(payload.url)
    : normalizePageUrl(payload.url);

  if (!isHttpUrl(mediaUrl)) {
    throw new Error('This page cannot be sent to MIXDM.');
  }

  // Build Referer header:
  // 1. Some CDNs (e.g. Pixiv) require a specific Referer regardless of tab URL → use override table
  // 2. Otherwise use the page/tab URL that the user is currently on
  const reqHeaders = {};
  const requiredReferer = getRequiredReferer(mediaUrl);
  if (requiredReferer) {
    reqHeaders['Referer'] = requiredReferer;
  } else if (payload.referer) {
    reqHeaders['Referer'] = payload.referer;
  } else if (payload.tabUrl) {
    reqHeaders['Referer'] = payload.tabUrl;
  }

  const body = {
    url: mediaUrl,
    title: payload.title || '',
    thumbnail: payload.thumbnail || '',
    filename: payload.filename || inferFilename(mediaUrl),
    imageFormat: payload.imageFormat || 'original',
    format: payload.format || DEFAULT_FORMAT,
    segments: payload.mediaKind === 'image' ? 1 : payload.segments || 16,
    source: payload.source || 'browser-extension',
    headers: Object.keys(reqHeaders).length > 0 ? reqHeaders : undefined
  };

  const cookies = await getCookiesForUrl(mediaUrl);
  if (cookies.length) body.cookies = cookies;

  const result = await fetchJson('/api/extension/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (openApp) await focusMixdm();
  setBadge('OK', '#35c58a');
  return result;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'mixdm-page',
      title: 'Download page with MIXDM',
      contexts: ['page', 'video', 'audio']
    });
    chrome.contextMenus.create({
      id: 'mixdm-link',
      title: 'Download link with MIXDM',
      contexts: ['link']
    });
    chrome.contextMenus.create({
      id: 'mixdm-image',
      title: 'Download image as original',
      contexts: ['image']
    });
    chrome.contextMenus.create({
      id: 'mixdm-image-jpg',
      title: 'Download image as JPG',
      contexts: ['image']
    });
    chrome.contextMenus.create({
      id: 'mixdm-image-png',
      title: 'Download image as PNG',
      contexts: ['image']
    });
    chrome.contextMenus.create({
      id: 'mixdm-image-webp',
      title: 'Download image as WebP',
      contexts: ['image']
    });

    // Special overlay context menu overrides for sites with transparent protection layers (Pixiv, ArtStation, DeviantArt)
    const overlayPatterns = [
      "*://*.pixiv.net/*",
      "*://*.artstation.com/*",
      "*://*.deviantart.com/*",
      "*://*.deviantart.net/*",
      "*://*.wixmp.com/*",
      "*://*.sinaimg.cn/*"
    ];
    chrome.contextMenus.create({
      id: 'mixdm-overlay-image',
      title: 'Download image as original (Overlay Bypass)',
      contexts: ['page', 'link'],
      documentUrlPatterns: overlayPatterns
    });
    chrome.contextMenus.create({
      id: 'mixdm-overlay-image-jpg',
      title: 'Download image as JPG (Overlay Bypass)',
      contexts: ['page', 'link'],
      documentUrlPatterns: overlayPatterns
    });
    chrome.contextMenus.create({
      id: 'mixdm-overlay-image-png',
      title: 'Download image as PNG (Overlay Bypass)',
      contexts: ['page', 'link'],
      documentUrlPatterns: overlayPatterns
    });
    chrome.contextMenus.create({
      id: 'mixdm-overlay-image-webp',
      title: 'Download image as WebP (Overlay Bypass)',
      contexts: ['page', 'link'],
      documentUrlPatterns: overlayPatterns
    });

    chrome.contextMenus.create({
      id: 'mixdm-open',
      title: 'Open in MIXDM for options',
      contexts: ['page', 'link', 'video', 'audio']
    });
  });
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const [tab] = await tabsQuery({ active: true, currentWindow: true });
    const url = tab?.id === tabId ? tab.url : '';
    if (url) await bridgeCookiesForUrl(url, 'tab-activated');
  } catch (_) {}
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab?.url) return;
  bridgeCookiesForUrl(tab.url, 'tab-updated').catch(() => {});
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const pageUrl = tab?.url || '';
  const isOverlayClick = info.menuItemId.startsWith('mixdm-overlay-');
  
  const imageFormats = {
    'mixdm-image-jpg': 'jpg',
    'mixdm-image-png': 'png',
    'mixdm-image-webp': 'webp',
    'mixdm-overlay-image-jpg': 'jpg',
    'mixdm-overlay-image-png': 'png',
    'mixdm-overlay-image-webp': 'webp'
  };

  const triggerDownload = (targetUrl, targetMediaKind) => {
    const payload = {
      url: targetUrl,
      title: titleFromTab(tab),
      mediaKind: targetMediaKind,
      imageFormat: imageFormats[info.menuItemId] || 'original',
      source: `context-menu:${info.menuItemId}`,
      referer: pageUrl,
      tabUrl: pageUrl
    };

    if (info.menuItemId === 'mixdm-open') {
      openAnalyze(payload).catch(err => {
        setBadge('ERR', '#f05a5a');
        console.error(err);
      });
      return;
    }

    sendToMixdm(payload, { openApp: true }).catch(err => {
      setBadge('ERR', '#f05a5a');
      console.error(err);
      if (isHttpUrl(targetUrl)) openAnalyze(payload).catch(() => {});
    });
  };

  if (isOverlayClick && tab?.id !== undefined) {
    chrome.tabs.sendMessage(tab.id, { type: 'MIXDM_GET_CLICKED_IMAGE' }, (response) => {
      if (chrome.runtime.lastError || !response || !response.url) {
        // Fallback to standard page/link url
        const rawUrl = info.srcUrl || info.linkUrl || info.pageUrl || pageUrl || '';
        triggerDownload(rawUrl, 'page');
      } else {
        triggerDownload(response.url, 'image');
      }
    });
  } else {
    const rawUrl = info.srcUrl || info.linkUrl || info.pageUrl || pageUrl || '';
    const mediaKind = info.mediaType || (info.srcUrl ? 'image' : 'page');
    triggerDownload(rawUrl, mediaKind);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === 'MIXDM_STATUS') {
      return { status: await pingMixdm() };
    }

    if (message?.type === 'MIXDM_OPEN_ANALYZE') {
      await openAnalyze(message.payload || {});
      return { opened: true };
    }

    if (message?.type === 'MIXDM_ANALYZE') {
      return { info: await analyzeWithMixdm(message.payload || {}) };
    }

    if (message?.type === 'MIXDM_DOWNLOAD') {
      const payload = {
        ...(message.payload || {}),
        title: message.payload?.title || titleFromTab(sender.tab),
        source: message.payload?.source || 'content-script',
        referer: message.payload?.referer || sender.tab?.url || '',
        tabUrl: message.payload?.tabUrl || sender.tab?.url || ''
      };
      return { result: await sendToMixdm(payload, { openApp: true }) };
    }

    if (message?.type === 'MIXDM_GET_DETECTED_MEDIA') {
      const tabId = message.tabId;
      return { media: detectedMedia.get(tabId) || [] };
    }

    if (message?.type === 'MIXDM_GET_COUNT') {
      const tabId = sender.tab?.id;
      return { count: tabId !== undefined ? (detectedMedia.get(tabId) || []).length : 0 };
    }

    if (message?.type === 'MIXDM_GET_DETECTED_MEDIA_TAB') {
      const tabId = sender.tab?.id;
      return { media: tabId !== undefined ? (detectedMedia.get(tabId) || []) : [] };
    }

    if (message?.type === 'MIXDM_REPORT_MEDIA') {
      const tabId = sender.tab?.id;
      if (tabId !== undefined && message.url) {
        const title = message.title || titleFromTab(sender.tab);
        addDetectedMedia(tabId, message.url, title);
      }
      return { ok: true };
    }

    throw new Error('Unknown MIXDM extension message.');
  })()
    .then(data => sendResponse({ ok: true, ...data }))
    .catch(err => {
      setBadge('ERR', '#f05a5a');
      sendResponse({ ok: false, error: err.message });
    });

  return true;
});

// ─── Universal Media Grabber Sniffer Engine ──────────────────────────────
const detectedMedia = new Map(); // tabId -> Array of Media items

const MEDIA_URL_PATTERN = /\.(mp4|webm|mkv|flv|mov|avi|mp3|aac|wav|m4a|m3u8|mpd)(?:\?|$)/i;

function addDetectedMedia(tabId, url, tabTitle = '') {
  if (tabId < 0) return;
  if (!detectedMedia.has(tabId)) {
    detectedMedia.set(tabId, []);
  }
  const list = detectedMedia.get(tabId);
  if (list.some(m => m.url === url)) return;

  const parsedUrl = new URL(url);
  let ext = 'mp4';
  const extMatch = parsedUrl.pathname.match(/\.(mp4|webm|mkv|flv|mov|avi|mp3|aac|wav|m4a|m3u8|mpd)$/i);
  if (extMatch) {
    ext = extMatch[1].toLowerCase();
  }

  // Infer filename: first try pathname, fallback to tabTitle
  let filename = parsedUrl.pathname.split('/').pop() || 'media';
  if (filename.includes('?')) {
    filename = filename.split('?')[0];
  }
  filename = decodeURIComponent(filename).trim();
  
  if (!filename || filename === 'videoplayback' || filename === 'audio' || filename === 'video' || filename === 'manifest' || filename.length < 3) {
    // If the filename is generic, use the page tab title
    const baseTitle = tabTitle ? tabTitle.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() : 'media';
    filename = `${baseTitle}.${ext}`;
  } else if (!filename.endsWith(`.${ext}`)) {
    filename = `${filename}.${ext}`;
  }

  const mediaItem = {
    url,
    filename,
    ext,
    time: Date.now()
  };
  list.push(mediaItem);

  // Update badge count
  updateBadgeCount(tabId);
}

function updateBadgeCount(tabId) {
  const list = detectedMedia.get(tabId) || [];
  const countText = list.length > 0 ? String(list.length) : '';
  chrome.action.setBadgeText({ text: countText, tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#ff4444', tabId });
  
  // Send count to the tab content script
  try {
    chrome.tabs.sendMessage(tabId, { type: 'MIXDM_UPDATE_COUNT', count: list.length }, () => {
      if (chrome.runtime.lastError) { /* ignore if content script not loaded */ }
    });
  } catch (_) {}
}

// Listen to network requests to sniff media links
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const { tabId, url, method } = details;
    if (tabId < 0 || method !== 'GET') return;
    
    // Ignore requests to the local app itself
    if (url.includes('localhost:3737') || url.includes('127.0.0.1:3737')) return;

    if (MEDIA_URL_PATTERN.test(url)) {
      // Get the page title to name the file nicely
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          addDetectedMedia(tabId, url, '');
        } else {
          const title = titleFromTab(tab);
          addDetectedMedia(tabId, url, title);
        }
      });
    }
  },
  { urls: ["<all_urls>"] }
);

// Clear detected media on tab reload/navigation
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    detectedMedia.delete(tabId);
    chrome.action.setBadgeText({ text: '', tabId });
  }
});

// Clear on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  detectedMedia.delete(tabId);
});

// ─── Download Interception Engine ────────────────────────────────────────────
// When enabled, any file matching INTERCEPT_EXTENSIONS that Chrome starts
// downloading will be cancelled and re-sent to MIXDM instead.

const INTERCEPT_EXTENSIONS = new Set([
  // Archives
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'iso', 'cab',
  // Video
  'mp4', 'webm', 'mkv', 'mov', 'avi', 'flv', 'wmv', 'm4v', 'ts', 'vob',
  // Audio
  'mp3', 'm4a', 'aac', 'wav', 'flac', 'opus', 'ogg', 'wma', 'alac', 'aiff',
  // Executables / Installers
  'exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'appimage',
  // Documents / Data
  'pdf', 'epub', 'mobi',
  // Design / Media assets
  'psd', 'ai', 'sketch', 'fig', 'xcf', 'xd',
  // Torrents
  'torrent',
]);

// Persistent setting: is interception enabled?
let interceptEnabled = false;

// Load saved setting on startup
chrome.storage.sync.get({ interceptDownloads: false }, (data) => {
  interceptEnabled = data.interceptDownloads;
});

/**
 * Extract file extension from a URL or filename string.
 * Returns lowercase extension string, or '' if none found.
 */
function getExtFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const filename = pathname.split('/').pop() || '';
    const dotIdx = filename.lastIndexOf('.');
    if (dotIdx < 0) return '';
    return filename.slice(dotIdx + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
  } catch {
    return '';
  }
}

/**
 * Extract a clean filename from URL for MIXDM.
 */
function filenameFromDownload(item) {
  // Chrome sometimes gives us the suggested filename (with proper extension)
  if (item.filename && item.filename.trim()) {
    const parts = item.filename.replace(/\\/g, '/').split('/');
    const name = parts[parts.length - 1].trim();
    if (name) return name;
  }
  try {
    const pathname = new URL(item.finalUrl || item.url).pathname;
    const name = decodeURIComponent(pathname.split('/').pop() || '').trim();
    if (name) return name;
  } catch {}
  return 'download';
}

// Listen for new Chrome downloads
chrome.downloads.onCreated.addListener(async (downloadItem) => {
  // Only intercept when enabled
  if (!interceptEnabled) return;

  // Only intercept HTTP/HTTPS downloads
  const url = downloadItem.finalUrl || downloadItem.url || '';
  if (!url.startsWith('http://') && !url.startsWith('https://')) return;

  // Skip blob: and data: URLs — we can't download those with HTTP engine
  if (url.startsWith('blob:') || url.startsWith('data:')) return;

  // Check if the file extension is in our intercept list
  const ext = getExtFromUrl(url);
  if (!ext || !INTERCEPT_EXTENSIONS.has(ext)) return;

  // Cancel the Chrome download immediately
  try {
    await new Promise(resolve => chrome.downloads.cancel(downloadItem.id, resolve));
    // Also erase it from Chrome's download history so the bar doesn't flash
    await new Promise(resolve => chrome.downloads.erase({ id: downloadItem.id }, resolve));
  } catch (err) {
    console.warn('[MIXDM Intercept] Could not cancel Chrome download:', err);
    // Don't stop — still try to send to MIXDM
  }

  // Determine a sensible Referer:
  // Try to get it from the initiating tab, then fall back to the download URL origin
  let referer = '';
  try {
    if (downloadItem.tabId && downloadItem.tabId >= 0) {
      const tabs = await new Promise(resolve =>
        chrome.tabs.query({}, resolve)
      );
      const tab = tabs.find(t => t.id === downloadItem.tabId);
      if (tab?.url) referer = tab.url;
    }
  } catch {}

  if (!referer) {
    try {
      const parsed = new URL(url);
      referer = `${parsed.origin}/`;
    } catch {}
  }

  const filename = filenameFromDownload(downloadItem);

  // Build payload and forward to MIXDM
  const payload = {
    url,
    title: filename.replace(/\.[^/.]+$/, ''),
    filename,
    source: 'download-intercept',
    referer,
    tabUrl: referer,
    mediaKind: 'file',
  };

  try {
    await sendToMixdm(payload, { openApp: true });
    console.log('[MIXDM Intercept] Intercepted and sent to MIXDM:', url);
  } catch (err) {
    console.error('[MIXDM Intercept] Failed to send to MIXDM:', err.message);
    // If MIXDM is not running, open the URL in a new tab as a fallback
    chrome.tabs.create({ url });
  }
});

// ─── Intercept message handlers (for popup) ──────────────────────────────────
// These are merged into the existing runtime.onMessage listener by adding
// handlers below. We extend the handler using a separate listener for clarity.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'MIXDM_GET_INTERCEPT_STATUS') {
    sendResponse({ ok: true, enabled: interceptEnabled });
    return false; // synchronous
  }

  if (message?.type === 'MIXDM_SET_INTERCEPT') {
    const enabled = !!message.enabled;
    interceptEnabled = enabled;
    chrome.storage.sync.set({ interceptDownloads: enabled });
    sendResponse({ ok: true, enabled });
    return false; // synchronous
  }

  if (message?.type === 'MIXDM_GET_THEME') {
    (async () => {
      try {
        const res = await fetch(`${MIXDM_BASE}/api/settings`);
        const settings = await res.json();
        return { theme: settings.theme || 'default' };
      } catch (err) {
        return { theme: 'default' };
      }
    })().then(sendResponse);
    return true; // asynchronous
  }
});
