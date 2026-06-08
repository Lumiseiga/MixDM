const { EventEmitter } = require('events');
const { getSettings } = require('../../settings');
const {
  downloadYtdlp,
  parseSpeedStr,
  parseEtaStr,
  isYtdlpInstalled,
  detectPlatform,
  normalizeYtdlpUrl,
  isBrowserCookieReadError,
  isYtdlpFormatUnavailableError,
  isAudioOnlyFormat,
  getYtdlpPlaceholderExt,
} = require('../../ytdlp-engine');

const ytdlpEvents = new EventEmitter();
const ytTasks = new Map();
let ytTaskCounter = 1;
const SPEED_SMOOTHING_ALPHA = 0.35;
const COOKIE_BROWSER_FALLBACKS = ['edge', 'chrome', 'firefox', 'brave', 'vivaldi', 'opera'];
const FORMAT_UNAVAILABLE_FALLBACKS = ['best/bv*+ba/b', 'best'];
const YOUTUBE_EXTRACTOR_ARG_FALLBACKS = [
  'youtube:player_client=web_safari,web_embedded,android_vr',
  'youtube:player_client=default,tv,web_embedded,android_vr',
];

function isYoutubeUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com');
  } catch (_) {
    return false;
  }
}

function nextYoutubeExtractorArgs(task) {
  if (!isYoutubeUrl(task.url)) return null;
  task._extractorFallbackIndex = task._extractorFallbackIndex || 0;
  while (
    task._extractorFallbackIndex < YOUTUBE_EXTRACTOR_ARG_FALLBACKS.length &&
    YOUTUBE_EXTRACTOR_ARG_FALLBACKS[task._extractorFallbackIndex] === task.extractorArgs
  ) {
    task._extractorFallbackIndex++;
  }
  return YOUTUBE_EXTRACTOR_ARG_FALLBACKS[task._extractorFallbackIndex++] || null;
}

function nextCookieBrowser(current, attempted = new Set()) {
  attempted.add(current);
  for (const browser of COOKIE_BROWSER_FALLBACKS) {
    if (!attempted.has(browser)) return browser;
  }
  return null;
}

function smoothSpeed(previous, current) {
  if (!Number.isFinite(current) || current <= 0) return previous > 1 ? Math.round(previous * 0.65) : 0;
  if (!previous || previous <= 0) return Math.round(current);
  return Math.round((SPEED_SMOOTHING_ALPHA * current) + ((1 - SPEED_SMOOTHING_ALPHA) * previous));
}

function formatSpeed(bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '';
  const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s'];
  let value = bytesPerSecond;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const decimals = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)}${units[unitIndex]}`;
}

function resetYtdlpSpeed(task) {
  task._smoothedSpeed = 0;
  task.speed = 0;
  task.speedStr = '';
}

function applyYtdlpProgress(task, prog) {
  if (prog.status === 'merging') {
    task.status = 'merging';
    task.progress = 99;
  } else if (prog.percent !== undefined) {
    task.status = 'downloading';
    task.progress = prog.percent;
    task.etaStr = prog.etaStr || '';
    const rawSpeed = parseSpeedStr(prog.speedStr);
    task._smoothedSpeed = smoothSpeed(task._smoothedSpeed || 0, rawSpeed);
    task.speed = task._smoothedSpeed;
    task.speedStr = formatSpeed(task.speed);
    task.eta = parseEtaStr(prog.etaStr);
    if (prog.fileSize) {
      task.fileSize = prog.fileSize;
    }
  }
  if (prog.filename) {
    task.filename = prog.filename;
  }
}

class YtdlpTask {
  constructor(id, url, opts) {
    this.id = id;
    this.url = url;
    this.type = 'ytdlp';
    this.platform = detectPlatform(url);
    this.title = opts.title || '';
    this.thumbnail = opts.thumbnail || null;
    this.format = opts.format || 'bv*+ba/b';
    this.filename = opts.title
      ? `${opts.title}.${getYtdlpPlaceholderExt(this.format)}`
      : isAudioOnlyFormat(this.format) ? 'audio' : 'video.mp4';
    this.status = 'idle'; // idle | downloading | merging | done | error | cancelled
    this.progress = 0;
    this.speed = 0;
    this.eta = null;
    this.speedStr = '';
    this.etaStr = '';
    this.fileSize = 0;
    this.errorMessage = '';
    this.startTime = null;
    this.endTime = null;
    this.outputPath = null;
    this.noCookies = !!opts.noCookies;
    this.cookiesBrowser = this.noCookies ? null : (opts.cookiesBrowser || null);
    this.cookiesHeader = this.noCookies ? null : (opts.cookiesHeader || null);
    this.cookies = this.noCookies ? null : (Array.isArray(opts.cookies) ? opts.cookies : null);
    this.extractorArgs = opts.extractorArgs || null;
    this.speedLimitKbps = opts.speedLimitKbps || 0;
    this.speedPolicy = opts.speedPolicy || null;
    this._controller = null;
    this._smoothedSpeed = 0;
  }

  toJSON() {
    return {
      id: this.id,
      type: 'ytdlp',
      url: this.url,
      platform: this.platform,
      filename: this.filename,
      title: this.title,
      thumbnail: this.thumbnail,
      format: this.format,
      status: this.status,
      progress: Math.round(this.progress * 10) / 10,
      speed: this.speed,
      speedStr: this.speedStr,
      eta: this.eta,
      etaStr: this.etaStr,
      fileSize: this.fileSize,
      errorMessage: this.errorMessage,
      startTime: this.startTime,
      endTime: this.endTime,
      outputPath: this.outputPath,
      cookiesBrowser: this.cookiesBrowser,
      hasCookiesHeader: !!this.cookiesHeader,
      hasCookiesFile: Array.isArray(this.cookies) && this.cookies.length > 0,
      ytdlpNoCookies: !!this.noCookies,
      ytdlpExtractorArgs: this.extractorArgs || null,
      queuePosition: this.queuePosition || null,
      retryAttempt: this.retryAttempt || 0,
      retryMaxAttempts: this.retryMaxAttempts || 0,
      retryNextAt: this.retryNextAt || null,
      retryReason: this.retryReason || '',
      speedLimitKbps: this.speedLimitKbps || 0,
      speedPolicy: this.speedPolicy || null,
      // Emulate segments array (single segment for yt-dlp)
      segments: [{
        index: 0,
        progress: Math.round(this.progress * 10) / 10,
        speed: this.speed,
        status: this.status === 'done' ? 'done'
          : this.status === 'error' ? 'error'
          : this.status === 'cancelled' ? 'cancelled'
          : this.status === 'idle' ? 'idle'
          : this.status === 'queued' ? 'queued'
          : this.status === 'retrying' ? 'retrying'
          : 'downloading',
        downloaded: 0, total: 0, start: 0, end: -1
      }]
    };
  }
}

function createYtdlpTask({ url, format, title, thumbnail, fileSize, speedLimitKbps = 0, cookiesBrowser, cookiesHeader, cookies, extractorArgs = null, noCookies = false, speedPolicy = null }) {
  url = normalizeYtdlpUrl(url);
  const settings = getSettings();
  if (noCookies) {
    cookiesBrowser = null;
    cookiesHeader = null;
    cookies = null;
  }
  const hasCookieJar = Array.isArray(cookies) && cookies.length > 0;
  let selectedCookiesBrowser = (cookiesHeader || hasCookieJar) ? null : cookiesBrowser;
  if (!noCookies && !cookiesHeader && !hasCookieJar && !selectedCookiesBrowser && settings.cookiesEnabled) {
    selectedCookiesBrowser = settings.cookiesBrowser;
  }

  const id = `yt_${ytTaskCounter++}_${Date.now()}`;
  const task = new YtdlpTask(id, url, { title, thumbnail, format, cookiesBrowser: selectedCookiesBrowser, cookiesHeader, cookies, extractorArgs, noCookies, speedLimitKbps, speedPolicy });
  if (fileSize) task.fileSize = fileSize;
  ytTasks.set(id, task);
  return task;
}

function beginYtdlpDownload(task) {
  if (!task) return null;
  const settings = getSettings();
  let selectedCookiesBrowser = task.cookiesBrowser;
  task.status = 'downloading';
  task.startTime = Date.now();
  task.errorMessage = '';
  resetYtdlpSpeed(task);
  ytdlpEvents.emit('task-updated', task.toJSON());

  const onProgress = (prog) => {
    if (task.status === 'cancelled' || task.status === 'paused') return;
    applyYtdlpProgress(task, prog);
    ytdlpEvents.emit('task-updated', task.toJSON());
  };

  const onDone = ({ outputPath }) => {
    if (task.status === 'cancelled' || task.status === 'paused') return;
    task.status = 'done';
    task.progress = 100;
    resetYtdlpSpeed(task);
    task.eta = null;
    task.endTime = Date.now();
    task.outputPath = outputPath;
    ytdlpEvents.emit('task-updated', task.toJSON());
  };

  const onError = (err) => {
    if (task.status === 'cancelled' || task.status === 'paused') return;

    if (isYtdlpFormatUnavailableError(err) && !isAudioOnlyFormat(task.format)) {
      if (!task.noCookies && isYoutubeUrl(task.url) && (selectedCookiesBrowser || task.cookiesHeader || (Array.isArray(task.cookies) && task.cookies.length > 0))) {
        console.log(`[yt-dlp] Format unavailable for task ${task.id}. Retrying without cookies.`);
        task.noCookies = true;
        selectedCookiesBrowser = null;
        task.cookiesBrowser = null;
        task.cookiesHeader = null;
        task.cookies = null;
        task._formatFallbackIndex = 0;
        task._controller = downloadYtdlp(
          task.url,
          {
            format: task.format,
            speedLimitKbps: task.speedLimitKbps || 0,
            cookiesBrowser: null,
            cookiesHeader: null,
            cookies: null,
            extractorArgs: task.extractorArgs,
            downloadsDir: settings.downloadsDir,
            noCookies: true
          },
          onProgress,
          onDone,
          onError
        );
        return;
      }

      task._formatFallbackIndex = task._formatFallbackIndex || 0;
      while (
        task._formatFallbackIndex < FORMAT_UNAVAILABLE_FALLBACKS.length &&
        FORMAT_UNAVAILABLE_FALLBACKS[task._formatFallbackIndex] === task.format
      ) {
        task._formatFallbackIndex++;
      }
      const fallbackFormat = FORMAT_UNAVAILABLE_FALLBACKS[task._formatFallbackIndex++];
      if (fallbackFormat) {
        console.log(`[yt-dlp] Format unavailable for task ${task.id}. Retrying with format "${fallbackFormat}".`);
        task.format = fallbackFormat;
        task._controller = downloadYtdlp(
          task.url,
          {
            format: task.format,
            speedLimitKbps: task.speedLimitKbps || 0,
            cookiesBrowser: selectedCookiesBrowser,
            cookiesHeader: task.cookiesHeader,
            cookies: task.cookies,
            extractorArgs: task.extractorArgs,
            downloadsDir: settings.downloadsDir,
            noCookies: task.noCookies
          },
          onProgress,
          onDone,
          onError
        );
        return;
      }

      const fallbackExtractorArgs = nextYoutubeExtractorArgs(task);
      if (fallbackExtractorArgs) {
        console.log(`[yt-dlp] Format unavailable for task ${task.id}. Retrying with YouTube extractor args "${fallbackExtractorArgs}".`);
        task.extractorArgs = fallbackExtractorArgs;
        task._formatFallbackIndex = 0;
        task._controller = downloadYtdlp(
          task.url,
          {
            format: task.format,
            speedLimitKbps: task.speedLimitKbps || 0,
            cookiesBrowser: selectedCookiesBrowser,
            cookiesHeader: task.cookiesHeader,
            cookies: task.cookies,
            extractorArgs: task.extractorArgs,
            downloadsDir: settings.downloadsDir,
            noCookies: task.noCookies
          },
          onProgress,
          onDone,
          onError
        );
        return;
      }

    }

    if (selectedCookiesBrowser && isBrowserCookieReadError(err)) {
      task._cookieBrowserFailures = task._cookieBrowserFailures || new Set();
      const nextBrowser = nextCookieBrowser(selectedCookiesBrowser, task._cookieBrowserFailures);
      if (nextBrowser) {
        console.log(`[yt-dlp] Could not read ${selectedCookiesBrowser} cookies. Retrying task ${task.id} with ${nextBrowser} cookies.`);
        selectedCookiesBrowser = nextBrowser;
        task.cookiesBrowser = nextBrowser;
      } else {
        console.log(`[yt-dlp] Cookie error detected. Retrying task ${task.id} without cookies.`);
        selectedCookiesBrowser = null;
        task.cookiesBrowser = null;
      }
      task._controller = downloadYtdlp(
        task.url,
        {
          format: task.format,
          speedLimitKbps: task.speedLimitKbps || 0,
          cookiesBrowser: selectedCookiesBrowser,
          cookiesHeader: task.cookiesHeader,
          cookies: task.cookies,
          extractorArgs: task.extractorArgs,
          downloadsDir: settings.downloadsDir
        },
        onProgress,
        onDone,
        onError
      );
      return;
    }

    task.status = 'error';
    task.errorMessage = err.message;
    resetYtdlpSpeed(task);
    ytdlpEvents.emit('task-updated', task.toJSON());
  };

  task._controller = downloadYtdlp(
    task.url,
    {
      format: task.format,
      speedLimitKbps: task.speedLimitKbps || 0,
      cookiesBrowser: selectedCookiesBrowser,
      cookiesHeader: task.cookiesHeader,
      cookies: task.cookies,
      extractorArgs: task.extractorArgs,
      downloadsDir: settings.downloadsDir,
      noCookies: task.noCookies
    },
    onProgress,
    onDone,
    onError
  );

  return task;
}

function startExistingYtdlpTask(id) {
  const task = ytTasks.get(id);
  return beginYtdlpDownload(task);
}

function startYtdlpTask(args) {
  const task = createYtdlpTask(args);
  return beginYtdlpDownload(task);
}

function resumeYtdlpTask(id, { cookiesBrowser } = {}) {
  const task = ytTasks.get(id);
  if (!task) return null;
  if (task.status !== 'paused' && task.status !== 'error' && task.status !== 'cancelled') {
    return task;
  }

  if (cookiesBrowser !== undefined) {
    task.cookiesBrowser = cookiesBrowser;
  }
  let selectedCookiesBrowser = task.cookiesBrowser;

  task.status = 'downloading';
  task.startTime = Date.now();
  task.errorMessage = '';
  resetYtdlpSpeed(task);
  ytdlpEvents.emit('task-updated', task.toJSON());

  const onProgress = (prog) => {
    if (task.status === 'cancelled' || task.status === 'paused') return;
    applyYtdlpProgress(task, prog);
    ytdlpEvents.emit('task-updated', task.toJSON());
  };

  const onDone = ({ outputPath }) => {
    if (task.status === 'cancelled' || task.status === 'paused') return;
    task.status = 'done';
    task.progress = 100;
    resetYtdlpSpeed(task);
    task.eta = null;
    task.endTime = Date.now();
    task.outputPath = outputPath;
    ytdlpEvents.emit('task-updated', task.toJSON());
  };

  const onError = (err) => {
    if (task.status === 'cancelled' || task.status === 'paused') return;

    if (isYtdlpFormatUnavailableError(err) && !isAudioOnlyFormat(task.format)) {
      if (!task.noCookies && isYoutubeUrl(task.url) && (selectedCookiesBrowser || task.cookiesHeader || (Array.isArray(task.cookies) && task.cookies.length > 0))) {
        console.log(`[yt-dlp] Format unavailable on resume for task ${task.id}. Retrying without cookies.`);
        task.noCookies = true;
        selectedCookiesBrowser = null;
        task.cookiesBrowser = null;
        task.cookiesHeader = null;
        task.cookies = null;
        task._formatFallbackIndex = 0;
        task._controller = downloadYtdlp(
          task.url,
          {
            format: task.format,
            speedLimitKbps: task.speedLimitKbps || 0,
            cookiesBrowser: null,
            cookiesHeader: null,
            cookies: null,
            extractorArgs: task.extractorArgs,
            downloadsDir: settings.downloadsDir,
            noCookies: true
          },
          onProgress,
          onDone,
          onError
        );
        return;
      }

      task._formatFallbackIndex = task._formatFallbackIndex || 0;
      while (
        task._formatFallbackIndex < FORMAT_UNAVAILABLE_FALLBACKS.length &&
        FORMAT_UNAVAILABLE_FALLBACKS[task._formatFallbackIndex] === task.format
      ) {
        task._formatFallbackIndex++;
      }
      const fallbackFormat = FORMAT_UNAVAILABLE_FALLBACKS[task._formatFallbackIndex++];
      if (fallbackFormat) {
        console.log(`[yt-dlp] Format unavailable on resume for task ${task.id}. Retrying with format "${fallbackFormat}".`);
        task.format = fallbackFormat;
        task._controller = downloadYtdlp(
          task.url,
          {
            format: task.format,
            speedLimitKbps: task.speedLimitKbps || 0,
            cookiesBrowser: selectedCookiesBrowser,
            cookiesHeader: task.cookiesHeader,
            cookies: task.cookies,
            extractorArgs: task.extractorArgs,
            downloadsDir: settings.downloadsDir,
            noCookies: task.noCookies
          },
          onProgress,
          onDone,
          onError
        );
        return;
      }

      const fallbackExtractorArgs = nextYoutubeExtractorArgs(task);
      if (fallbackExtractorArgs) {
        console.log(`[yt-dlp] Format unavailable on resume for task ${task.id}. Retrying with YouTube extractor args "${fallbackExtractorArgs}".`);
        task.extractorArgs = fallbackExtractorArgs;
        task._formatFallbackIndex = 0;
        task._controller = downloadYtdlp(
          task.url,
          {
            format: task.format,
            speedLimitKbps: task.speedLimitKbps || 0,
            cookiesBrowser: selectedCookiesBrowser,
            cookiesHeader: task.cookiesHeader,
            cookies: task.cookies,
            extractorArgs: task.extractorArgs,
            downloadsDir: settings.downloadsDir,
            noCookies: task.noCookies
          },
          onProgress,
          onDone,
          onError
        );
        return;
      }

    }

    if (selectedCookiesBrowser && isBrowserCookieReadError(err)) {
      task._cookieBrowserFailures = task._cookieBrowserFailures || new Set();
      const nextBrowser = nextCookieBrowser(selectedCookiesBrowser, task._cookieBrowserFailures);
      if (nextBrowser) {
        console.log(`[yt-dlp] Could not read ${selectedCookiesBrowser} cookies on resume. Retrying task ${task.id} with ${nextBrowser} cookies.`);
        selectedCookiesBrowser = nextBrowser;
        task.cookiesBrowser = nextBrowser;
      } else {
        console.log(`[yt-dlp] Cookie error detected on resume. Retrying task ${task.id} without cookies.`);
        selectedCookiesBrowser = null;
        task.cookiesBrowser = null;
      }
      task._controller = downloadYtdlp(
        task.url,
        {
          format: task.format,
          speedLimitKbps: task.speedLimitKbps || 0,
          cookiesBrowser: selectedCookiesBrowser,
          cookiesHeader: task.cookiesHeader,
          cookies: task.cookies,
          extractorArgs: task.extractorArgs,
          downloadsDir: settings.downloadsDir
        },
        onProgress,
        onDone,
        onError
      );
      return;
    }

    task.status = 'error';
    task.errorMessage = err.message;
    resetYtdlpSpeed(task);
    ytdlpEvents.emit('task-updated', task.toJSON());
  };

  const settings = getSettings();
  task._controller = downloadYtdlp(
    task.url,
    {
      format: task.format,
      speedLimitKbps: task.speedLimitKbps || 0,
      cookiesBrowser: selectedCookiesBrowser,
      cookiesHeader: task.cookiesHeader,
      cookies: task.cookies,
      extractorArgs: task.extractorArgs,
      downloadsDir: settings.downloadsDir,
      noCookies: task.noCookies
    },
    onProgress,
    onDone,
    onError
  );

  return task;
}

module.exports = {
  YtdlpTask,
  createYtdlpTask,
  startExistingYtdlpTask,
  startYtdlpTask,
  resumeYtdlpTask,
  ytTasks,
  ytdlpEvents
};
