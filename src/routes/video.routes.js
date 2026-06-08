const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getSettings } = require('../../settings');
const {
  isYtdlpUrl,
  normalizeYtdlpUrl,
  isYtdlpInstalled,
  analyzeYtdlp,
  isBrowserCookieReadError,
  isYtdlpAuthError,
  isYtdlpFormatUnavailableError,
  downloadYtdlp,
  parseSpeedStr,
  parseEtaStr,
} = require('../../ytdlp-engine');
const { createYtdlpTask, resumeYtdlpTask, ytTasks, ytdlpEvents } = require('../services/ytdlp.service');
const { checkSafety, sanitizeFilename } = require('../services/safety.service');
const { manager } = require('../services/download.service');
const { DOWNLOADS_DIR } = require('../utils/file');
const { serverEvents } = require('../utils/events');
const { applySpeedPolicy } = require('../services/speedQuota.service');
const { resolveSpeedMode } = require('../services/speedMode.service');
const { enqueueTask, removeFromQueue, processQueue } = require('../services/queue.service');
const { clearRetry } = require('../services/retry.service');
const { getCookiesForUrl } = require('../services/cookieBridge.service');

const router = express.Router();
const COOKIE_BROWSER_FALLBACKS = ['edge', 'chrome', 'firefox', 'brave', 'vivaldi', 'opera'];
const ANALYZE_CACHE_TTL_MS = 10 * 60 * 1000;
const ANALYZE_CACHE_MAX_ENTRIES = 80;
const YOUTUBE_FAST_EXTRACTOR_ARGS = 'youtube:player_client=web_safari,web_embedded,android_vr';
const YOUTUBE_ANALYZE_FORMAT_FALLBACKS = [
  { format: 'best', extractorArgs: YOUTUBE_FAST_EXTRACTOR_ARGS },
  { format: 'bv*+ba/b', extractorArgs: YOUTUBE_FAST_EXTRACTOR_ARGS },
  { format: 'best' },
  { format: 'best', extractorArgs: 'youtube:player_client=default,tv,web_embedded,android_vr' },
];
const analyzeCache = new Map();

function cookieBrowserCandidates(preferred) {
  const values = [preferred, ...COOKIE_BROWSER_FALLBACKS].filter(Boolean);
  return [...new Set(values.map(value => String(value).toLowerCase()))];
}

function isYoutubeUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com');
  } catch (_) {
    return false;
  }
}

function hasCookieMaterial(opts = {}) {
  return !!opts.cookiesBrowser || !!opts.cookiesHeader || (Array.isArray(opts.cookies) && opts.cookies.length > 0);
}

function withoutCookies(opts = {}) {
  return {
    ...opts,
    cookiesBrowser: null,
    cookiesHeader: null,
    cookies: null,
    noCookies: true
  };
}

function hashForCache(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function cookieJarCacheHash(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return '';
  const compact = cookies.map(cookie => ({
    domain: cookie?.domain || '',
    path: cookie?.path || '',
    name: cookie?.name || '',
    value: cookie?.value || ''
  }));
  return hashForCache(JSON.stringify(compact));
}

function getAnalyzeCacheKey({ normalizedUrl, cookiesBrowser, cookiesHeader, cookies, noCookies, preferCookies }) {
  let authKey = 'guest';
  if (noCookies) {
    authKey = 'no-cookies';
  } else if (cookiesHeader) {
    authKey = `header:${hashForCache(cookiesHeader)}`;
  } else if (Array.isArray(cookies) && cookies.length > 0) {
    authKey = `jar:${cookieJarCacheHash(cookies)}`;
  } else if (cookiesBrowser) {
    authKey = `browser:${String(cookiesBrowser).toLowerCase()}`;
  }
  if (preferCookies && !noCookies) {
    authKey = `prefer:${authKey}`;
  }
  return `${normalizedUrl}|${authKey}`;
}

function cloneAnalyzePayload(payload) {
  return JSON.parse(JSON.stringify(payload));
}

function cacheableAnalyzePayload(payload) {
  const copy = cloneAnalyzePayload(payload);
  delete copy.fromCache;
  return copy;
}

function getCachedAnalyze(cacheKey) {
  const entry = analyzeCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > ANALYZE_CACHE_TTL_MS) {
    analyzeCache.delete(cacheKey);
    return null;
  }
  const payload = cloneAnalyzePayload(entry.payload);
  payload.fromCache = true;
  return payload;
}

function setCachedAnalyze(cacheKey, payload) {
  analyzeCache.set(cacheKey, {
    createdAt: Date.now(),
    payload: cacheableAnalyzePayload(payload)
  });
  while (analyzeCache.size > ANALYZE_CACHE_MAX_ENTRIES) {
    const oldestKey = analyzeCache.keys().next().value;
    analyzeCache.delete(oldestKey);
  }
}

function analyzeAttemptKey(opts = {}) {
  return [
    opts.format || '',
    opts.extractorArgs || opts.ytdlpExtractorArgs || '',
    opts.noCookies ? 'no-cookies' : 'with-cookies',
    opts.cookiesBrowser || '',
    opts.cookiesHeader ? 'header' : '',
    Array.isArray(opts.cookies) && opts.cookies.length > 0 ? 'jar' : ''
  ].join('|');
}

function buildAnalyzeFallbackAttempts(url, baseOpts = {}) {
  const youtube = isYoutubeUrl(url);
  const attempts = [];
  const seen = new Set([analyzeAttemptKey(baseOpts)]);
  const add = (opts) => {
    const key = analyzeAttemptKey(opts);
    if (!seen.has(key)) {
      seen.add(key);
      attempts.push(opts);
    }
  };

  if (youtube && hasCookieMaterial(baseOpts) && !baseOpts.noCookies) {
    add(withoutCookies(baseOpts));
  }

  const formatFallbacks = youtube
    ? YOUTUBE_ANALYZE_FORMAT_FALLBACKS
    : [{ format: 'best' }];

  for (const attempt of formatFallbacks) {
    add({ ...baseOpts, ...attempt });
  }

  if (youtube && hasCookieMaterial(baseOpts) && !baseOpts.noCookies) {
    add({ ...withoutCookies(baseOpts), format: 'best', extractorArgs: YOUTUBE_FAST_EXTRACTOR_ARGS });
  }

  return attempts;
}

async function analyzeWithFormatFallbacks(url, baseOpts = {}) {
  try {
    const info = await analyzeYtdlp(url, baseOpts);
    return { info, format: baseOpts.format || null, extractorArgs: baseOpts.extractorArgs || null, noCookies: !!baseOpts.noCookies };
  } catch (err) {
    if (!isYtdlpFormatUnavailableError(err)) throw err;

    let lastErr = err;
    const attempts = buildAnalyzeFallbackAttempts(url, baseOpts);

    for (const attempt of attempts) {
      try {
        const info = await analyzeYtdlp(url, attempt);
        console.log(`[yt-dlp] analyze fallback succeeded format=${attempt.format || 'auto'} extractorArgs=${attempt.extractorArgs || 'default'} noCookies=${!!attempt.noCookies}`);
        return {
          info,
          format: attempt.format || baseOpts.format || null,
          extractorArgs: attempt.extractorArgs || baseOpts.extractorArgs || null,
          noCookies: !!attempt.noCookies
        };
      } catch (retryErr) {
        lastErr = retryErr;
        if (!isYtdlpFormatUnavailableError(retryErr) && !attempt.noCookies) break;
      }
    }

    throw lastErr;
  }
}

// Analyze URL (smart: detect if yt-dlp or HTTP)
router.post('/analyze', async (req, res) => {
  let { url, headers, cookiesBrowser, cookiesHeader, cookies, ytdlpNoCookies, noCookies, preferCookies } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  const normalizedUrl = normalizeYtdlpUrl(url);
  const noCookiesRequested = !!(ytdlpNoCookies || noCookies);
  const cookiesPreferred = !!preferCookies;

  // If it's a social media URL → use yt-dlp
  if (isYtdlpUrl(normalizedUrl)) {
    if (!isYtdlpInstalled()) {
      return res.status(503).json({
        error: 'yt-dlp is not installed. Please restart the server.',
        isYtdlp: true,
        ytdlpMissing: true
      });
    }
    const settings = getSettings();
    if (!noCookiesRequested && !cookiesHeader && !(Array.isArray(cookies) && cookies.length > 0)) {
      const bridged = getCookiesForUrl(normalizedUrl);
      if (bridged) {
        cookiesHeader = bridged.cookiesHeader;
        cookies = bridged.cookies;
      }
    }
    if (noCookiesRequested) {
      cookiesHeader = null;
      cookies = null;
      cookiesBrowser = null;
    }
    const hasCookieJar = Array.isArray(cookies) && cookies.length > 0;
    let selectedCookiesBrowser = (cookiesHeader || hasCookieJar) ? null : cookiesBrowser;
    if (!noCookiesRequested && !cookiesHeader && !hasCookieJar && !selectedCookiesBrowser && settings.cookiesEnabled) {
      selectedCookiesBrowser = settings.cookiesBrowser;
    }
    const analyzeCacheKey = getAnalyzeCacheKey({
      normalizedUrl,
      cookiesBrowser: selectedCookiesBrowser,
      cookiesHeader,
      cookies,
      noCookies: noCookiesRequested,
      preferCookies: cookiesPreferred
    });
    const baseAnalyzeOpts = { cookiesBrowser: selectedCookiesBrowser, cookiesHeader, cookies, noCookies: noCookiesRequested };
    const shouldTryGuestFirst = isYoutubeUrl(normalizedUrl) &&
      !noCookiesRequested &&
      !cookiesPreferred &&
      hasCookieMaterial(baseAnalyzeOpts);
    const cachedAnalyze = getCachedAnalyze(analyzeCacheKey);
    if (cachedAnalyze) {
      return res.json(cachedAnalyze);
    }
    if (shouldTryGuestFirst) {
      const guestCachedAnalyze = getCachedAnalyze(getAnalyzeCacheKey({
        normalizedUrl,
        noCookies: true
      }));
      if (guestCachedAnalyze) {
        setCachedAnalyze(analyzeCacheKey, guestCachedAnalyze);
        return res.json(guestCachedAnalyze);
      }
    }
    let info;
    let ytdlpExtractorArgs = null;
    let cookieWarning = null;
    try {
      let analyzed;
      if (shouldTryGuestFirst) {
        try {
          analyzed = await analyzeWithFormatFallbacks(normalizedUrl, withoutCookies(baseAnalyzeOpts));
        } catch (guestErr) {
          if (!isYtdlpAuthError(guestErr)) throw guestErr;
          analyzed = await analyzeWithFormatFallbacks(normalizedUrl, baseAnalyzeOpts);
        }
      } else {
        analyzed = await analyzeWithFormatFallbacks(normalizedUrl, baseAnalyzeOpts);
      }
      info = analyzed.info;
      ytdlpExtractorArgs = analyzed.extractorArgs || null;
      ytdlpNoCookies = !!analyzed.noCookies;
      if (ytdlpNoCookies) selectedCookiesBrowser = null;
    } catch (err) {
      if (selectedCookiesBrowser && isBrowserCookieReadError(err)) {
        const failedCookiesBrowser = selectedCookiesBrowser;
        const fallbackErrors = [];

        for (const candidate of cookieBrowserCandidates(failedCookiesBrowser)) {
          if (candidate === failedCookiesBrowser) continue;
          try {
            const analyzed = await analyzeWithFormatFallbacks(normalizedUrl, { cookiesBrowser: candidate });
            info = analyzed.info;
            ytdlpExtractorArgs = analyzed.extractorArgs || null;
            ytdlpNoCookies = !!analyzed.noCookies;
            selectedCookiesBrowser = candidate;
            cookieWarning = `Could not read ${failedCookiesBrowser} cookies. Using ${candidate} cookies instead.`;
            break;
          } catch (candidateErr) {
            fallbackErrors.push(candidateErr);
          }
        }

        if (!info) {
          try {
            const analyzed = await analyzeWithFormatFallbacks(normalizedUrl, { cookiesBrowser: null });
            info = analyzed.info;
            ytdlpExtractorArgs = analyzed.extractorArgs || null;
            ytdlpNoCookies = !!analyzed.noCookies;
            selectedCookiesBrowser = null;
            cookieWarning = `Could not read ${failedCookiesBrowser} cookies. Using guest access. Close the browser and retry with cookies for restricted videos.`;
          } catch (retryErr) {
            const authRequired = isYtdlpAuthError(retryErr) || fallbackErrors.some(isYtdlpAuthError);
            return res.status(400).json({
              error: `${retryErr.message} (Could not read ${failedCookiesBrowser} cookies. Close ${failedCookiesBrowser} or try Edge/Firefox/Brave cookies.)`,
              isYtdlp: true,
              authRequired,
              canRetryWithCookies: true,
              cookiesBrowser: failedCookiesBrowser
            });
          }
        }
      } else {
        return res.status(400).json({
          error: err.message,
          isYtdlp: true,
          authRequired: isYtdlpAuthError(err),
          canRetryWithCookies: isYtdlpAuthError(err),
          cookiesBrowser: selectedCookiesBrowser || settings.cookiesBrowser || 'chrome'
        });
      }
    }
    const payload = {
      isYtdlp: true,
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      uploader: info.uploader,
      platform: info.platform,
      formats: info.formats,
      ext: info.ext,
      filename: `${info.title}.${info.ext}`,
      fileSize: 0,
      supportsRange: false,
      cookieWarning,
      cookiesBrowser: ytdlpNoCookies ? null : (selectedCookiesBrowser || null),
      ytdlpExtractorArgs,
      ytdlpNoCookies: !!ytdlpNoCookies,
      normalizedUrl: info.normalizedUrl || normalizedUrl,
    };
    setCachedAnalyze(analyzeCacheKey, payload);
    if (ytdlpNoCookies) {
      setCachedAnalyze(getAnalyzeCacheKey({ normalizedUrl, noCookies: true }), payload);
    }
    return res.json(payload);
  }

  // Otherwise → standard HTTP analysis
  try {
    const task = manager.createTask(url, { segments: 1, headers });
    await manager._analyzeUrl(task);
    manager.removeTask(task.id);
    res.json({
      isYtdlp: false,
      filename: task.filename,
      fileSize: task.fileSize,
      supportsRange: task.supportsRange,
      contentType: task.contentType,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Start a new YouTube/Social task
router.post('/yt-tasks', async (req, res) => {
  let { url, format, title, thumbnail, fileSize, speedLimitKbps = 0, speedMode, cookiesBrowser, cookiesHeader, cookies, bypassSafety, ytdlpExtractorArgs, extractorArgs, ytdlpNoCookies, noCookies } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  const normalizedUrl = normalizeYtdlpUrl(url);
  const noCookiesRequested = !!(ytdlpNoCookies || noCookies);
  if (!noCookiesRequested && !cookiesHeader && !(Array.isArray(cookies) && cookies.length > 0)) {
    const bridged = getCookiesForUrl(normalizedUrl);
    if (bridged) {
      cookiesHeader = bridged.cookiesHeader;
      cookies = bridged.cookies;
    }
  }

  if (noCookiesRequested) {
    cookiesBrowser = null;
    cookiesHeader = null;
    cookies = null;
  }

  if (!bypassSafety) {
    const safety = checkSafety(normalizedUrl, title);
    if (!safety.safe) {
      return res.status(400).json({
        safetyWarning: true,
        error: safety.message
      });
    }
  }

  const speedModePolicy = resolveSpeedMode({ requestedSpeedLimitKbps: speedLimitKbps, speedMode });
  const speedPolicy = applySpeedPolicy({
    userEmail: req.userEmail,
    requestedSpeedLimitKbps: speedModePolicy.effectiveRequestedSpeedLimitKbps
  });
  speedPolicy.speedMode = speedModePolicy;
  const task = createYtdlpTask({
    url: normalizedUrl,
    format,
    title,
    thumbnail,
    fileSize,
    speedLimitKbps: speedPolicy.effectiveSpeedLimitKbps,
    cookiesBrowser,
    cookiesHeader,
    cookies,
    extractorArgs: ytdlpExtractorArgs || extractorArgs || null,
    noCookies: noCookiesRequested,
    speedPolicy
  });
  enqueueTask(task);
  serverEvents.emit('download-started', task.toJSON());
  res.json(task.toJSON());
});

// Pause yt-dlp task
router.post('/yt-tasks/:id/pause', (req, res) => {
  const task = ytTasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task._controller) task._controller.cancel();
  task.status = 'paused';
  task.speed = 0;
  task.speedStr = '';
  task.eta = null;
  task.etaStr = '';
  ytdlpEvents.emit('task-updated', task.toJSON());
  res.json({ success: true, task: task.toJSON() });
});

// Resume yt-dlp task
// Resume yt-dlp task
router.post('/yt-tasks/:id/resume', (req, res) => {
  const queuedTask = ytTasks.get(req.params.id);
  if (queuedTask && queuedTask.status === 'queued') {
    processQueue();
    return res.json({ success: true, task: queuedTask.toJSON() });
  }
  const cookiesBrowser = req.body ? req.body.cookiesBrowser : undefined;
  const task = resumeYtdlpTask(req.params.id, { cookiesBrowser });
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({ success: true, task: task.toJSON() });
});

// Cancel yt-dlp task (acts as pause/stop)
router.post('/yt-tasks/:id/cancel', (req, res) => {
  clearRetry(req.params.id);
  const task = ytTasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task._controller) task._controller.cancel();
  task.status = 'cancelled';
  task.speed = 0;
  task.speedStr = '';
  task.eta = null;
  task.etaStr = '';
  task.endTime = Date.now();
  ytdlpEvents.emit('task-updated', task.toJSON());
  res.json({ success: true, task: task.toJSON() });
});

// Remove yt-dlp task (also cleans up partial files)
router.delete('/yt-tasks/:id', (req, res) => {
  const task = ytTasks.get(req.params.id);
  if (task) {
    const snapshot = task.toJSON();
    clearRetry(req.params.id);
    removeFromQueue(req.params.id);
    const shouldEmitCancelled = !['done', 'error', 'cancelled'].includes(snapshot.status);
    if (shouldEmitCancelled) {
      task.status = 'cancelled';
      task.speed = 0;
      task.speedStr = '';
      task.eta = null;
      task.etaStr = '';
      task.endTime = Date.now();
    }
    if (task._controller) task._controller.cancel();
    
    // Cleanup partial files in DOWNLOADS_DIR
    try {
      if (fs.existsSync(DOWNLOADS_DIR)) {
        const files = fs.readdirSync(DOWNLOADS_DIR);
        // Clean title for matching
        const cleanTitle = task.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 150);
        files.forEach(file => {
          if (file.includes(cleanTitle) && (file.endsWith('.part') || file.endsWith('.temp') || file.endsWith('.ytdl'))) {
            const filePath = path.join(DOWNLOADS_DIR, file);
            if (fs.existsSync(filePath)) {
              try { fs.unlinkSync(filePath); } catch (_) {}
            }
          }
        });
      }
    } catch (e) {
      console.error('Failed to clean up yt-dlp temp files:', e);
    }
    
    if (shouldEmitCancelled) {
      ytdlpEvents.emit('task-updated', task.toJSON());
    }
    ytTasks.delete(req.params.id);
    processQueue();
  }
  res.json({ success: true });
});

module.exports = router;
