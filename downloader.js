/**
 * MIXDM - Core Download Engine
 * Segmented Downloader with Pause/Resume capability
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');
const { spawn } = require('child_process');
const { URL } = require('url');
const { appDataPath, resourcePath } = require('./app-paths');

// Save to system Downloads/MIXDM folder
const DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads', 'MIXDM');
const TEMP_DIR = process.env.MIXDM_TEMP_DIR || appDataPath('tmp');
const FFMPEG_BIN = resourcePath('bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const IMAGE_OUTPUT_FORMATS = new Set(['jpg', 'jpeg', 'png', 'webp']);

// Ensure directories exist
[DOWNLOADS_DIR, TEMP_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Browser-like headers to avoid 403 blocks
const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'identity',
  'Connection': 'keep-alive',
  'Sec-Fetch-Dest': 'image',
  'Sec-Fetch-Mode': 'no-cors',
  'Sec-Fetch-Site': 'cross-site'
};

function getRequiredReferer(mediaUrl) {
  try {
    const parsed = new URL(mediaUrl);
    const hostname = parsed.hostname;
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

const MAX_REDIRECTS = 10;
const SPEED_SMOOTHING_ALPHA = 0.35;
const SPEED_SAMPLE_INTERVAL_MS = 1000;
const PROGRESS_EMIT_MIN_INTERVAL_MS = 750;
const STREAM_HIGH_WATER_MARK = 1024 * 1024;
const ACTIVE_PROGRESS_STATUSES = new Set(['downloading', 'merging', 'extracting']);
const TERMINAL_STATUSES = new Set(['done', 'error', 'cancelled']);
const HTTP_AGENT = new http.Agent({
  keepAlive: true,
  maxSockets: 128,
  maxFreeSockets: 32,
  timeout: 60000
});
const HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  maxSockets: 128,
  maxFreeSockets: 32,
  timeout: 60000
});

function agentForProtocol(protocol) {
  return protocol === 'https:' ? HTTPS_AGENT : HTTP_AGENT;
}

function smoothSpeed(previous, current) {
  if (!Number.isFinite(current) || current <= 0) return previous > 1 ? Math.round(previous * 0.65) : 0;
  if (!previous || previous <= 0) return Math.round(current);
  return Math.round((SPEED_SMOOTHING_ALPHA * current) + ((1 - SPEED_SMOOTHING_ALPHA) * previous));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Follow redirects manually, returning the final URL and response headers.
 * Supports HEAD with fallback to GET if HEAD returns 403/405.
 */
function fetchMeta(url, customHeaders = null, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));

    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error('Invalid URL')); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      method: 'HEAD',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: { ...BASE_HEADERS, ...customHeaders },
      agent: agentForProtocol(parsed.protocol),
      highWaterMark: STREAM_HIGH_WATER_MARK,
      timeout: 15000
    };

    const req = lib.request(options, (res) => {
      const { statusCode, headers } = res;
      // Consume the response to free the socket
      res.resume();

      // Redirect
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        const location = headers['location'];
        if (!location) return reject(new Error('Redirect with no location'));
        const nextUrl = new URL(location, url).href;
        return fetchMeta(nextUrl, customHeaders, redirectsLeft - 1).then(resolve).catch(reject);
      }

      // HEAD was blocked → retry with GET (range 0-0 just to read headers)
      if (statusCode === 403 || statusCode === 405) {
        return fetchMetaViaGet(url, customHeaders, redirectsLeft).then(resolve).catch(reject);
      }

      if (statusCode >= 400) return reject(new Error(`HTTP ${statusCode}`));

      resolve({ finalUrl: url, headers, statusCode });
    });

    req.on('error', (err) => {
      // Network error on HEAD → try GET
      fetchMetaViaGet(url, customHeaders, redirectsLeft).then(resolve).catch(reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Connection timed out')); });
    req.end();
  });
}

/**
 * Fallback: use GET with Range: bytes=0-0 to read headers without downloading the full file.
 */
function fetchMetaViaGet(url, customHeaders = null, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));

    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error('Invalid URL')); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: { ...BASE_HEADERS, ...customHeaders, 'Range': 'bytes=0-0' },
      agent: agentForProtocol(parsed.protocol),
      highWaterMark: STREAM_HIGH_WATER_MARK,
      timeout: 15000
    };

    const req = lib.request(options, (res) => {
      const { statusCode, headers } = res;
      res.resume(); // Discard body

      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        const location = headers['location'];
        if (!location) return reject(new Error('Redirect with no location'));
        const nextUrl = new URL(location, url).href;
        return fetchMetaViaGet(nextUrl, customHeaders, redirectsLeft - 1).then(resolve).catch(reject);
      }

      if (statusCode >= 400) return reject(new Error(`HTTP ${statusCode}`));
      resolve({ finalUrl: url, headers, statusCode });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Connection timed out')); });
    req.end();
  });
}

/**
 * Perform a GET request with redirect following and write to a stream.
 * Calls onData(chunk) for each data chunk received.
 */
function getWithRedirects(url, headers, onData, onEnd, onError, redirectsLeft = MAX_REDIRECTS, onRequest = null) {
  if (redirectsLeft <= 0) return onError(new Error('Too many redirects'));

  let parsed;
  try { parsed = new URL(url); } catch { return onError(new Error('Invalid URL')); }

  const lib = parsed.protocol === 'https:' ? https : http;
  const options = {
    method: 'GET',
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    headers: { ...BASE_HEADERS, ...headers },
    agent: agentForProtocol(parsed.protocol),
    highWaterMark: STREAM_HIGH_WATER_MARK,
    timeout: 60000
  };

  const req = lib.request(options, (res) => {
    const { statusCode } = res;

    if ([301, 302, 303, 307, 308].includes(statusCode)) {
      res.resume();
      const location = res.headers['location'];
      if (!location) return onError(new Error('Redirect with no location'));
      const nextUrl = new URL(location, url).href;
      return getWithRedirects(nextUrl, headers, onData, onEnd, onError, redirectsLeft - 1, onRequest);
    }

    if (statusCode >= 400) {
      res.resume();
      return onError(new Error(`HTTP ${statusCode}`));
    }

    const rangeHeader = options.headers['Range'] || options.headers['range'];
    if (rangeHeader && statusCode === 200) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d+)?/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : -1;
        if (start > 0 || end !== -1) {
          res.resume();
          return onError(new Error('Server does not support range/resume requests (returned HTTP 200 instead of 206)'));
        }
      }
    }

    res.on('data', (chunk) => onData(chunk, res));
    res.on('end', onEnd);
    res.on('error', onError);
  });

  req.on('error', onError);
  if (typeof onRequest === 'function') onRequest(req);
  req.on('socket', (socket) => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);
  });
  req.on('timeout', () => { req.destroy(); onError(new Error('Request timed out')); });
  req.end();

  return req;
}

// ─── DownloadSegment ──────────────────────────────────────────────────────────

class DownloadSegment {
  constructor(index, start, end) {
    this.index = index;
    this.start = start;
    this.end = end;
    this.downloaded = 0;
    this.status = 'pending'; // pending | downloading | paused | done | error
    this.speed = 0;
    this._smoothedSpeed = 0;
    this._lastBytes = 0;
    this._lastTime = Date.now();
  }

  get total() {
    if (this.end === -1) return this.downloaded || 0; // Unknown size
    return this.end - this.start + 1;
  }

  get progress() {
    if (this.end === -1) return this.status === 'done' ? 100 : 0;
    return this.total > 0 ? Math.min((this.downloaded / this.total) * 100, 100) : 0;
  }
}

// ─── DownloadTask ──────────────────────────────────────────────────────────────

class DownloadTask {
  constructor({ id, url, filename, segments = 16, imageFormat = 'original', speedLimitBps = 0, headers = null }) {
    this.id = id;
    this.url = url;
    this.filename = filename;
    this.sourceFilename = filename;
    this.imageFormat = imageFormat;
    this.segments = segments;
    this.speedLimitBps = speedLimitBps; // 0 = unlimited
    this.headers = headers; // Custom headers (e.g. Referer)
    this.fileSize = 0;
    this.supportsRange = false;
    this.contentType = '';
    this.status = 'idle';
    this.errorMessage = '';
    this.startTime = null;
    this.endTime = null;
    this.segmentList = [];
    this._requests = [];
    this._paused = false;
    // Shared token bucket for rate limiting across all segments
    this._tokenBucket = {
      tokens: speedLimitBps > 0 ? speedLimitBps : 0,
      lastRefill: Date.now()
    };
  }

  get totalDownloaded() {
    return this.segmentList.reduce((s, seg) => s + seg.downloaded, 0);
  }

  get progress() {
    if (this.status === 'done') return 100;
    return this.fileSize > 0 ? Math.min((this.totalDownloaded / this.fileSize) * 100, 100) : 0;
  }

  get speed() {
    return this.segmentList.reduce((s, seg) => s + seg.speed, 0);
  }

  get eta() {
    const remaining = this.fileSize - this.totalDownloaded;
    return this.speed > 0 ? Math.ceil(remaining / this.speed) : null;
  }

  toJSON() {
    return {
      id: this.id,
      url: this.url,
      filename: this.filename,
      imageFormat: this.imageFormat,
      fileSize: this.fileSize,
      supportsRange: this.supportsRange,
      contentType: this.contentType,
      status: this.status,
      errorMessage: this.errorMessage,
      progress: Math.round(this.progress * 10) / 10,
      totalDownloaded: this.totalDownloaded,
      speed: this.speed,
      eta: this.eta,
      startTime: this.startTime,
      endTime: this.endTime,
      outputPath: this.outputPath || null,
      queuePosition: this.queuePosition || null,
      retryAttempt: this.retryAttempt || 0,
      retryMaxAttempts: this.retryMaxAttempts || 0,
      retryNextAt: this.retryNextAt || null,
      retryReason: this.retryReason || '',
      speedLimitKbps: this.speedLimitBps > 0 ? Math.round(this.speedLimitBps / 1024) : 0,
      speedPolicy: this.speedPolicy || null,
      connectionPolicy: this.connectionPolicy || null,
      segments: this.segmentList.map(seg => ({
        index: seg.index,
        start: seg.start,
        end: seg.end,
        downloaded: seg.downloaded,
        total: seg.total,
        progress: Math.round(seg.progress * 10) / 10,
        speed: seg.speed,
        status: seg.status
      }))
    };
  }
}

// ─── DownloadManager ──────────────────────────────────────────────────────────

class DownloadManager {
  constructor() {
    this.tasks = new Map();
    this._listeners = [];
    this._emitState = new Map();
    this._idCounter = 1;
  }

  onProgress(fn) { this._listeners.push(fn); }

  _emitNow(task) {
    if (!task) return;
    const data = task.toJSON();
    const state = this._emitState.get(task.id);
    if (state?.timer) clearTimeout(state.timer);

    if (TERMINAL_STATUSES.has(data.status)) {
      this._emitState.delete(task.id);
    } else {
      this._emitState.set(task.id, {
        status: data.status,
        time: Date.now(),
        timer: null,
        pending: null
      });
    }

    for (const fn of this._listeners) fn(data);
  }

  _emit(task, options = {}) {
    if (!task) return;

    const state = this._emitState.get(task.id);
    const now = Date.now();
    const statusChanged = state?.status !== task.status;
    const shouldThrottle = !options.force &&
      ACTIVE_PROGRESS_STATUSES.has(task.status) &&
      !statusChanged;

    if (!shouldThrottle || !state || now - state.time >= PROGRESS_EMIT_MIN_INTERVAL_MS) {
      this._emitNow(task);
      return;
    }

    state.pending = task;
    if (!state.timer) {
      state.timer = setTimeout(() => {
        const latest = this._emitState.get(task.id);
        if (latest?.pending) {
          this._emitNow(latest.pending);
        }
      }, Math.max(0, PROGRESS_EMIT_MIN_INTERVAL_MS - (now - state.time)));
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  createTask(url, options = {}) {
    const id = `dl_${this._idCounter++}_${Date.now()}`;
    const imageFormat = this._normalizeImageFormat(options.imageFormat);
    const speedLimitBps = (options.speedLimitKbps && options.speedLimitKbps > 0)
      ? Math.round(options.speedLimitKbps * 1024)
      : 0;

    const headers = { ...(options.headers || {}) };
    let cleanUrl = url;

    // Parse URL credentials if present (Basic Authentication extraction)
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.username || parsedUrl.password) {
        const user = decodeURIComponent(parsedUrl.username || '');
        const pass = decodeURIComponent(parsedUrl.password || '');
        const auth = Buffer.from(`${user}:${pass}`).toString('base64');
        headers['Authorization'] = `Basic ${auth}`;
        parsedUrl.username = '';
        parsedUrl.password = '';
        cleanUrl = parsedUrl.href;
      }
    } catch (_) {}

    const sourceFilename = options.filename || this._guessFilename(cleanUrl);
    const filename = imageFormat === 'original'
      ? sourceFilename
      : this._replaceExtension(sourceFilename, imageFormat === 'jpeg' ? 'jpg' : imageFormat);

    const requiredReferer = getRequiredReferer(cleanUrl);
    if (requiredReferer && !headers['Referer'] && !headers['referer']) {
      headers['Referer'] = requiredReferer;
    }

    const task = new DownloadTask({
      id,
      url: cleanUrl,
      filename,
      segments: options.segments || 8,
      imageFormat,
      speedLimitBps,
      headers: Object.keys(headers).length > 0 ? headers : null
    });
    task.sourceFilename = sourceFilename;
    this.tasks.set(id, task);
    return task;
  }

  getTask(id) { return this.tasks.get(id); }
  getAllTasks() { return Array.from(this.tasks.values()).map(t => t.toJSON()); }

  async startTask(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error('Task not found');
    if (!['idle', 'error'].includes(task.status)) return;

    task.status = 'analyzing';
    task.startTime = Date.now();
    task.errorMessage = '';
    this._emit(task);

    try {
      await this._analyzeUrl(task);
      this._emit(task);
      await this._downloadTask(task);
    } catch (err) {
      if (task.status !== 'paused') {
        task.status = 'error';
        task.errorMessage = this._friendlyError(err);
        this._emit(task);
      }
    }
  }

  pauseTask(id) {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'downloading') return false;
    task._paused = true;
    task.status = 'paused';

    if (task._ftpClient) {
      try {
        task._ftpClient.close();
      } catch (_) {}
      task._ftpClient = null;
    }

    for (const req of task._requests) {
      try { req.destroy(); } catch (_) {}
    }
    task._requests = [];
    task.segmentList.forEach(seg => {
      if (seg.status === 'downloading') seg.status = 'paused';
    });
    this._emit(task);
    return true;
  }

  async resumeTask(id) {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'paused') return false;
    task._paused = false;
    task.status = 'downloading';
    this._emit(task);
    await this._downloadTask(task, true);
    return true;
  }

  async refreshTaskUrl(id, newUrl, force = false) {
    const task = this.tasks.get(id);
    if (!task) throw new Error('Task not found');

    if (!['paused', 'error'].includes(task.status)) {
      throw new Error('Task must be paused or in error state to refresh URL');
    }

    let newMeta;
    try {
      newMeta = await fetchMeta(newUrl, task.headers);
    } catch (err) {
      throw new Error(`Failed to verify new URL: ${err.message}`);
    }

    let newSize = parseInt(newMeta.headers['content-length'] || '0', 10);
    const cr = newMeta.headers['content-range'] || '';
    const crMatch = cr.match(/bytes \d+-\d+\/(\d+)/);
    if (crMatch) newSize = parseInt(crMatch[1], 10);

    if (task.fileSize > 0 && newSize > 0 && task.fileSize !== newSize) {
      if (!force) {
        throw new Error(`SIZE_MISMATCH: ไฟล์ใหม่มีขนาดไม่เท่าเดิม (ไฟล์เดิม: ${task.fileSize} bytes, ไฟล์ใหม่: ${newSize} bytes)`);
      } else {
        task.segmentList.forEach((_, i) => {
          const tmpFile = this._segmentPath(task, i);
          if (fs.existsSync(tmpFile)) {
            try { fs.unlinkSync(tmpFile); } catch (_) {}
          }
        });
        task.fileSize = newSize;
        task.supportsRange = (newMeta.headers['accept-ranges'] === 'bytes') && newSize > 0;
        if (newMeta.statusCode === 206) task.supportsRange = true;
        task.segmentList = this._buildSegments(task);
      }
    } else {
      if (task.fileSize === 0 && newSize > 0) {
        task.fileSize = newSize;
        task.supportsRange = (newMeta.headers['accept-ranges'] === 'bytes') && newSize > 0;
        if (newMeta.statusCode === 206) task.supportsRange = true;
        task.segmentList = this._buildSegments(task);
      }
    }

    task.url = newMeta.finalUrl;
    task.contentType = newMeta.headers['content-type'] || task.contentType;
    task.errorMessage = '';
    task.status = 'paused';
    this._emit(task);
  }

  cancelTask(id) {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (['done', 'error', 'cancelled'].includes(task.status)) return false;
    
    this.pauseTask(id);
    task.status = 'cancelled';
    
    // Cleanup temp files
    task.segmentList.forEach((_, i) => {
      const tmpFile = this._segmentPath(task, i);
      if (fs.existsSync(tmpFile)) { try { fs.unlinkSync(tmpFile); } catch (_) {} }
    });
    
    task.speed = 0;
    task.eta = null;
    task.endTime = Date.now();
    this._emit(task);
    return true;
  }

  removeTask(id) {
    const task = this.tasks.get(id);
    if (task) {
      this.pauseTask(id);
      task.segmentList.forEach((_, i) => {
        const tmpFile = this._segmentPath(task, i);
        if (fs.existsSync(tmpFile)) { try { fs.unlinkSync(tmpFile); } catch (_) {} }
      });
    }
    this.tasks.delete(id);
  }

  // ── Core: Analyze URL ────────────────────────────────────────────────────

  async _analyzeUrl(task) {
    if (task.url.startsWith('ftp://') || task.url.startsWith('ftps://')) {
      await this._analyzeFtpUrl(task);
      return;
    }

    const { finalUrl, headers, statusCode } = await fetchMeta(task.url, task.headers);

    // Update URL in case of redirects
    task.url = finalUrl;

    // Content-Length: check both content-length and content-range
    let fileSize = parseInt(headers['content-length'] || '0', 10);
    // For partial content (206), content-range tells us the full size
    const cr = headers['content-range'] || '';
    const crMatch = cr.match(/bytes \d+-\d+\/(\d+)/);
    if (crMatch) fileSize = parseInt(crMatch[1], 10);

    task.fileSize = fileSize;
    task.supportsRange = (headers['accept-ranges'] === 'bytes') && fileSize > 0;
    // Also infer from 206 response
    if (statusCode === 206) task.supportsRange = true;
    task.contentType = headers['content-type'] || '';

    // Filename from Content-Disposition
    const cd = headers['content-disposition'] || '';
    const fnMatch = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
    if (fnMatch) {
      task.filename = decodeURIComponent(fnMatch[1].trim());
    } else if (!task.filename || task.filename === 'download') {
      task.filename = this._guessFilename(task.url, task.contentType);
    }

    if (task.imageFormat && task.imageFormat !== 'original') {
      const outputExt = task.imageFormat === 'jpeg' ? 'jpg' : task.imageFormat;
      task.sourceFilename = task.filename || this._guessFilename(task.url, task.contentType);
      task.filename = this._replaceExtension(task.sourceFilename, outputExt);
    }
  }

  async _analyzeFtpUrl(task) {
    const ftp = require('basic-ftp');
    const client = new ftp.Client();
    client.ftp.verbose = false;

    let parsed;
    try { parsed = new URL(task.url); } catch { throw new Error('Invalid FTP URL'); }

    const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'ftps:' ? 990 : 21);
    const secure = parsed.protocol === 'ftps:';

    try {
      await client.access({
        host: parsed.hostname,
        port: port,
        user: decodeURIComponent(parsed.username || 'anonymous'),
        password: decodeURIComponent(parsed.password || 'anonymous'),
        secure: secure
      });

      let size = 0;
      let supportsRange = false;
      try {
        size = await client.size(parsed.pathname);
        supportsRange = size > 0;
      } catch (_) {}

      task.fileSize = size;
      task.supportsRange = supportsRange;
      task.contentType = 'application/octet-stream';

      if (!task.filename || task.filename === 'download') {
        const base = path.basename(parsed.pathname);
        task.filename = base ? decodeURIComponent(base) : 'download';
      }
    } catch (err) {
      throw new Error(`FTP connection failed: ${err.message}`);
    } finally {
      client.close();
    }
  }

  // ── Core: Download Orchestrator ──────────────────────────────────────────

  async _downloadTask(task, isResume = false) {
    task.status = 'downloading';

    if (task.url.startsWith('ftp://') || task.url.startsWith('ftps://')) {
      await this._downloadFtpTask(task, isResume);
      return;
    }

    if (!isResume) {
      task.segmentList = this._buildSegments(task);
    }

    const pendingSegs = task.segmentList.filter(seg => seg.status !== 'done');
    await Promise.all(pendingSegs.map(seg => this._downloadSegment(task, seg)));

    if (task._paused) return;

    const allDone = task.segmentList.every(seg => seg.status === 'done');
    if (!allDone) {
      const errSeg = task.segmentList.find(seg => seg.status === 'error');
      throw new Error(errSeg ? `Segment ${errSeg.index + 1} failed` : 'Download incomplete');
    }

    task.status = 'merging';
    this._emit(task);
    await this._mergeSegments(task);

    task.status = 'done';
    task.endTime = Date.now();
    this._emit(task);
  }

  async _downloadFtpTask(task, isResume = false) {
    if (!isResume) {
      task.segmentList = [new DownloadSegment(0, 0, task.fileSize > 0 ? task.fileSize - 1 : -1)];
    }

    const seg = task.segmentList[0];
    seg.status = 'downloading';
    this._emit(task);

    const ftp = require('basic-ftp');
    const client = new ftp.Client();
    client.ftp.verbose = false;

    let parsed;
    try { parsed = new URL(task.url); } catch { throw new Error('Invalid FTP URL'); }

    const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'ftps:' ? 990 : 21);
    const secure = parsed.protocol === 'ftps:';

    const tmpFile = this._segmentPath(task, 0);
    const writeStream = fs.createWriteStream(tmpFile, {
      flags: seg.downloaded > 0 ? 'a' : 'w',
      highWaterMark: STREAM_HIGH_WATER_MARK
    });

    let lastBytes = seg.downloaded;
    let lastTime = Date.now();
    let speedTimer = setInterval(() => {
      const now = Date.now();
      const elapsed = (now - lastTime) / 1000;
      if (elapsed > 0) {
        const currentSpeed = Math.round((seg.downloaded - lastBytes) / elapsed);
        seg._smoothedSpeed = smoothSpeed(seg._smoothedSpeed, currentSpeed);
        seg.speed = seg._smoothedSpeed;
        lastBytes = seg.downloaded;
        lastTime = now;
      }
      this._emit(task);
    }, SPEED_SAMPLE_INTERVAL_MS);

    task._ftpClient = client;

    try {
      await client.access({
        host: parsed.hostname,
        port: port,
        user: decodeURIComponent(parsed.username || 'anonymous'),
        password: decodeURIComponent(parsed.password || 'anonymous'),
        secure: secure
      });

      const { PassThrough } = require('stream');
      const progressTrackStream = new PassThrough();
      progressTrackStream.on('data', (chunk) => {
        if (task._paused) {
          progressTrackStream.destroy();
          return;
        }
        seg.downloaded += chunk.length;
        if (!writeStream.write(chunk)) {
          progressTrackStream.pause();
          writeStream.once('drain', () => {
            if (!task._paused) progressTrackStream.resume();
          });
        }
      });

      await client.downloadToStream(progressTrackStream, parsed.pathname, seg.downloaded);

      await new Promise(resolve => writeStream.end(resolve));

      clearInterval(speedTimer);
      seg._smoothedSpeed = 0;
      seg.speed = 0;
      seg.status = 'done';
      client.close();
      task._ftpClient = null;

      if (task._paused) return;

      task.status = 'merging';
      this._emit(task);
      await this._mergeSegments(task);

      task.status = 'done';
      task.endTime = Date.now();
      this._emit(task);
    } catch (err) {
      clearInterval(speedTimer);
      await new Promise(resolve => writeStream.end(resolve));
      client.close();
      task._ftpClient = null;

      if (task._paused) {
        seg.status = 'paused';
        seg._smoothedSpeed = 0;
        seg.speed = 0;
        this._emit(task);
      } else {
        seg.status = 'error';
        seg._smoothedSpeed = 0;
        seg.speed = 0;
        throw err;
      }
    }
  }

  _buildSegments(task) {
    if (!task.supportsRange || task.fileSize === 0) {
      // Single segment (unknown or no range support)
      return [new DownloadSegment(0, 0, task.fileSize > 0 ? task.fileSize - 1 : -1)];
    }
    const minSegmentSize = 8 * 1024 * 1024;
    const usefulSegmentCount = Math.max(1, Math.ceil(task.fileSize / minSegmentSize));
    const count = Math.min(task.segments, usefulSegmentCount, task.fileSize);
    const chunkSize = Math.floor(task.fileSize / count);
    return Array.from({ length: count }, (_, i) => {
      const start = i * chunkSize;
      const end = i === count - 1 ? task.fileSize - 1 : start + chunkSize - 1;
      return new DownloadSegment(i, start, end);
    });
  }

  // ── Core: Download Single Segment ────────────────────────────────────────

  _downloadSegment(task, seg) {
    return new Promise((resolve, reject) => {
      let retries = 0;
      const maxRetries = 3;

      const attemptDownload = () => {
        if (task._paused) { resolve(); return; }

        // If already fully downloaded, skip
        const startByte = seg.start + seg.downloaded;
        const endByte = seg.end;
        if (seg.end !== -1 && startByte > endByte) {
          seg.status = 'done';
          resolve();
          return;
        }

        const tmpFile = this._segmentPath(task, seg.index);
        seg.status = 'downloading';

        // Build Range header if applicable
        const extraHeaders = { ...(task.headers || {}) };
        if (task.supportsRange && seg.end !== -1) {
          extraHeaders['Range'] = `bytes=${startByte}-${endByte}`;
        }

        // Speed meter
        let speedTimer = setInterval(() => {
          const now = Date.now();
          const elapsed = (now - seg._lastTime) / 1000;
          if (elapsed > 0) {
            const currentSpeed = Math.round((seg.downloaded - seg._lastBytes) / elapsed);
            seg._smoothedSpeed = smoothSpeed(seg._smoothedSpeed, currentSpeed);
            seg.speed = seg._smoothedSpeed;
            seg._lastBytes = seg.downloaded;
            seg._lastTime = now;
          }
          this._emit(task);
        }, SPEED_SAMPLE_INTERVAL_MS);

        const writeStream = fs.createWriteStream(tmpFile, {
          flags: seg.downloaded > 0 ? 'a' : 'w',
          highWaterMark: STREAM_HIGH_WATER_MARK
        });

        let settled = false;
        let req = null;
        const segmentRequests = [];
        let pendingWrites = 0;
        let responseEnded = false;

        const maybeFinish = () => {
          if (responseEnded && pendingWrites === 0 && !settled) {
            finish(null);
          }
        };

        const finish = (err) => {
          if (settled) return;
          settled = true;
          clearInterval(speedTimer);
          writeStream.end(() => {
            if (req) {
              for (const request of segmentRequests) {
                const reqIdx = task._requests.indexOf(request);
                if (reqIdx > -1) task._requests.splice(reqIdx, 1);
              }
            }

            if (err) {
              if (!task._paused && retries < maxRetries) {
                retries++;
                seg.status = 'downloading';
                seg._smoothedSpeed = 0;
                seg.speed = 0;
                this._emit(task);
                console.log(`[MIXDM] Segment ${seg.index + 1} failed. Retrying attempt ${retries}/${maxRetries} in 2000ms... Error: ${err.message}`);
                setTimeout(attemptDownload, 2000);
              } else {
                seg.status = 'error';
                reject(err);
              }
            } else {
              seg._smoothedSpeed = 0;
              seg.speed = 0;
              seg.status = 'done';
              this._emit(task);
              resolve();
            }
          });
        };

        writeStream.on('error', finish);

        const throttleDelayMs = (chunkLen) => {
          const limit = task.speedLimitBps;
          if (!limit || limit <= 0) return 0;

          const bucket = task._tokenBucket;
          const now = Date.now();
          const elapsed = Math.max(0, (now - bucket.lastRefill) / 1000);
          bucket.tokens = Math.min(limit * 2, bucket.tokens + elapsed * limit);
          bucket.lastRefill = now;

          if (bucket.tokens >= chunkLen) {
            bucket.tokens -= chunkLen;
            return 0;
          }

          const waitMs = Math.ceil(((chunkLen - bucket.tokens) / limit) * 1000);
          bucket.tokens = 0;
          bucket.lastRefill = now + waitMs;
          return waitMs;
        };

        req = getWithRedirects(
          task.url,
          extraHeaders,
          // onData
          (chunk, response) => {
            if (task._paused || settled) { return; }
            pendingWrites++;
            const delayMs = throttleDelayMs(chunk.length);
            if (delayMs > 0 && response && typeof response.pause === 'function') {
              response.pause();
            }

            const writeChunk = () => {
              if (task._paused || settled) {
                pendingWrites--;
                maybeFinish();
                return;
              }

              seg.downloaded += chunk.length;
              const flushed = writeStream.write(chunk);
              if (!flushed && response && typeof response.pause === 'function') {
                response.pause();
                writeStream.once('drain', () => {
                  pendingWrites--;
                  if (!task._paused && !settled && typeof response.resume === 'function') {
                    response.resume();
                  }
                  maybeFinish();
                });
              } else {
                pendingWrites--;
                if (!task._paused && !settled && response && typeof response.resume === 'function' &&
                    typeof response.isPaused === 'function' && response.isPaused()) {
                  response.resume();
                }
                maybeFinish();
              }
            };

            if (delayMs > 0) {
              setTimeout(writeChunk, delayMs);
            } else {
              writeChunk();
            }
          },
          // onEnd
          () => {
            if (task._paused) { clearInterval(speedTimer); resolve(); return; }
            responseEnded = true;
            maybeFinish();
          },
          // onError
          (err) => {
            if (task._paused) { clearInterval(speedTimer); resolve(); return; }
            finish(err);
          },
          MAX_REDIRECTS,
          (request) => {
            segmentRequests.push(request);
            task._requests.push(request);
          }
        );
      };

      attemptDownload();
    });
  }

  // ── Core: Merge Segments ────────────────────────────────────────────────

  async _mergeSegments(task) {
    const shouldConvertImage = task.imageFormat && task.imageFormat !== 'original';
    
    let downloadsDir = DOWNLOADS_DIR;
    try {
      const { getSettings } = require('./settings');
      downloadsDir = getSettings().downloadsDir || DOWNLOADS_DIR;
    } catch (_) {}

    if (!fs.existsSync(downloadsDir)) {
      fs.mkdirSync(downloadsDir, { recursive: true });
    }

    const finalPath = path.join(downloadsDir, this._safeFilename(task.filename));
    const sourceExt = path.extname(task.sourceFilename || task.filename) || '.img';
    const outPath = shouldConvertImage
      ? path.join(TEMP_DIR, `${task.id}_source${sourceExt}`)
      : finalPath;

    if (!shouldConvertImage && task.segmentList.length === 1) {
      const tmpFile = this._segmentPath(task, 0);
      if (fs.existsSync(tmpFile)) {
        if (fs.existsSync(finalPath)) {
          try { fs.unlinkSync(finalPath); } catch (_) {}
        }
        try {
          fs.renameSync(tmpFile, finalPath);
        } catch (err) {
          if (err.code !== 'EXDEV') throw err;
          await new Promise((resolve, reject) => {
            const readStream = fs.createReadStream(tmpFile, { highWaterMark: STREAM_HIGH_WATER_MARK });
            const writeStream = fs.createWriteStream(finalPath, { highWaterMark: STREAM_HIGH_WATER_MARK });
            readStream.on('error', reject);
            writeStream.on('error', reject);
            writeStream.on('finish', resolve);
            readStream.pipe(writeStream);
          });
          if (fs.existsSync(tmpFile)) { try { fs.unlinkSync(tmpFile); } catch (_) {} }
        }
        task.outputPath = finalPath;
        return finalPath;
      }
    }

    const writeStream = fs.createWriteStream(outPath, { highWaterMark: STREAM_HIGH_WATER_MARK });

    for (const seg of task.segmentList) {
      const tmpFile = this._segmentPath(task, seg.index);
      await new Promise((resolve, reject) => {
        if (!fs.existsSync(tmpFile)) { resolve(); return; }
        const readStream = fs.createReadStream(tmpFile, { highWaterMark: STREAM_HIGH_WATER_MARK });
        readStream.pipe(writeStream, { end: false });
        readStream.on('end', resolve);
        readStream.on('error', reject);
      });
    }

    await new Promise(resolve => writeStream.end(resolve));

    // Cleanup temp files
    task.segmentList.forEach((_, i) => {
      const tmpFile = this._segmentPath(task, i);
      if (fs.existsSync(tmpFile)) { try { fs.unlinkSync(tmpFile); } catch (_) {} }
    });

    if (shouldConvertImage) {
      await this._convertImage(outPath, finalPath, task.imageFormat);
      if (fs.existsSync(outPath)) { try { fs.unlinkSync(outPath); } catch (_) {} }
      task.outputPath = finalPath;
      return finalPath;
    }

    task.outputPath = finalPath;
    return finalPath;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  _segmentPath(task, index) {
    return path.join(TEMP_DIR, `${task.id}_seg${index}.tmp`);
  }

  _safeFilename(name) {
    return (name || 'download').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 200);
  }

  _normalizeImageFormat(format) {
    const value = String(format || 'original').toLowerCase();
    if (value === 'original') return 'original';
    return IMAGE_OUTPUT_FORMATS.has(value) ? value : 'original';
  }

  _replaceExtension(filename, ext) {
    const cleanExt = ext.replace(/^\./, '');
    const parsed = path.parse(filename || 'download');
    return `${parsed.name || 'download'}.${cleanExt}`;
  }

  _convertImage(inputPath, outputPath, format) {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(FFMPEG_BIN)) {
        return reject(new Error('ffmpeg.exe not found. Cannot convert image format.'));
      }

      const normalized = format === 'jpeg' ? 'jpg' : format;
      const args = ['-y', '-i', inputPath];
      if (normalized === 'jpg') {
        args.push(
          '-filter_complex',
          '[0:v]format=rgba[fg];color=c=white:s=16x16[bg];[bg][fg]scale2ref[bg][fg];[bg][fg]overlay=format=auto,format=yuv420p,setsar=1',
          '-frames:v',
          '1',
          '-q:v',
          '2',
          '-update',
          '1'
        );
      } else if (normalized === 'png') {
        args.push('-frames:v', '1', '-compression_level', '6', '-update', '1');
      } else if (normalized === 'webp') {
        args.push('-frames:v', '1', '-lossless', '1', '-compression_level', '6', '-update', '1');
      }
      args.push(outputPath);

      const proc = spawn(FFMPEG_BIN, args);
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('error', reject);
      proc.on('close', code => {
        if (code === 0) return resolve();
        const lines = stderr.split('\n').map(l => l.trim()).filter(Boolean);
        reject(new Error(lines[lines.length - 1] || `Image conversion failed with code ${code}`));
      });
    });
  }

  _guessFilename(url, contentType = '') {
    try {
      const urlObj = new URL(url);
      const base = path.basename(urlObj.pathname.split('?')[0]);
      if (base && base.length > 1 && base.includes('.')) return decodeURIComponent(base);
      const extMap = {
        'application/zip': '.zip', 'application/x-zip-compressed': '.zip',
        'application/pdf': '.pdf', 'application/x-tar': '.tar.gz',
        'video/mp4': '.mp4', 'video/x-matroska': '.mkv',
        'audio/mpeg': '.mp3', 'audio/flac': '.flac',
        'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
        'application/octet-stream': '.bin'
      };
      const type = contentType.split(';')[0].trim();
      return `download${extMap[type] || ''}`;
    } catch {
      return 'download';
    }
  }

  _friendlyError(err) {
    const msg = err.message || '';
    if (msg.includes('403') || msg.includes('Forbidden')) {
      return 'ลิงก์หมดอายุหรือการเข้าถึงถูกปฏิเสธ (HTTP 403 Forbidden) กรุณาใช้ลิงก์ใหม่';
    }
    if (msg.includes('404') || msg.includes('Not Found')) {
      return 'ไม่พบไฟล์ดาวน์โหลดตามที่อยู่ที่ระบุ (HTTP 404 Not Found)';
    }
    if (msg.includes('401') || msg.includes('Unauthorized')) {
      return 'ลิงก์ต้องระบุสิทธิ์การเข้าถึง (HTTP 401 Unauthorized)';
    }
    if (msg.includes('timeout') || msg.includes('Timeout') || msg.includes('timed out')) {
      return 'หมดเวลาการเชื่อมต่อเครือข่าย เครือข่ายขาดการตอบสนอง (Timeout) กำลังรอเชื่อมต่อใหม่';
    }
    if (msg.includes('ENOTFOUND') || msg.includes('getaddrinfo')) {
      return 'ไม่สามารถเชื่อมต่ออินเทอร์เน็ตหรือหาที่อยู่เว็บไม่พบ (DNS Error)';
    }
    if (msg.includes('ECONNREFUSED')) {
      return 'การเชื่อมต่อถูกปฏิเสธโดยเซิร์ฟเวอร์ปลายทาง (Connection Refused)';
    }
    if (msg.includes('ECONNRESET')) {
      return 'การเชื่อมต่อหลุดกระทันหัน (Connection Reset) กำลังลองใหม่...';
    }
    return msg;
  }
}

module.exports = { DownloadManager };
