const ACTIVE_STATUSES = new Set(['queued', 'retrying', 'starting', 'analyzing', 'downloading', 'merging', 'extracting', 'paused', 'pausing', 'resuming']);
const PAUSABLE_STATUSES = new Set(['analyzing', 'downloading', 'merging', 'extracting']);

let latestTasks = [];
let primaryAction = 'pause';

const card = document.getElementById('hud-card');
const iconSymbol = document.getElementById('hud-icon-symbol');
const titleEl = document.getElementById('hud-title');
const subtitleEl = document.getElementById('hud-subtitle');
const fillEl = document.getElementById('hud-progress-fill');
const sizeEl = document.getElementById('hud-size');
const speedEl = document.getElementById('hud-speed');
const badgeEl = document.getElementById('hud-badge');
const primaryBtn = document.getElementById('hud-primary');
const cancelBtn = document.getElementById('hud-cancel');
const openMainBtn = document.getElementById('hud-open-main');

function fmtBytes(bytes) {
  if (!bytes || bytes <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function fmtSpeed(bps) {
  if (!bps || bps <= 0) return '-';
  return `${fmtBytes(bps)}/s`;
}

function fmtETA(seconds) {
  if (!seconds || seconds <= 0) return '-';
  if (seconds < 60) return `${seconds}s left`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s left`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m left`;
}

function cleanLabel(value, fallback = 'Download') {
  const raw = String(value || fallback);
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    return raw;
  }
}

function taskLabel(task, fallback = 'Download') {
  return cleanLabel(task?.title || task?.filename, fallback);
}

function downloadedBytes(task) {
  if (task.fileSize > 0 && task.type === 'ytdlp') {
    return Math.round(task.fileSize * ((task.progress || 0) / 100));
  }
  return task.totalDownloaded || 0;
}

function aggregate(tasks) {
  const active = tasks.filter(task => ACTIVE_STATUSES.has(task.status));
  const terminal = tasks.filter(task => ['done', 'error', 'cancelled'].includes(task.status));
  const focusTasks = active.length > 0 ? active : terminal;
  const totalKnown = focusTasks.every(task => task.fileSize > 0);
  const totalBytes = focusTasks.reduce((sum, task) => sum + (task.fileSize || 0), 0);
  const downloaded = focusTasks.reduce((sum, task) => sum + downloadedBytes(task), 0);
  const avgProgress = focusTasks.length
    ? focusTasks.reduce((sum, task) => sum + (task.progress || 0), 0) / focusTasks.length
    : 0;
  const progress = totalKnown && totalBytes > 0 ? (downloaded / totalBytes) * 100 : avgProgress;
  const speed = active.reduce((sum, task) => sum + (task.speed || 0), 0);
  const eta = active.reduce((max, task) => Math.max(max, task.eta || 0), 0);
  const pausedCount = active.filter(task => task.status === 'paused').length;
  const queuedCount = active.filter(task => task.status === 'queued').length;
  const retryingCount = active.filter(task => task.status === 'retrying').length;
  const pausableCount = active.filter(task => PAUSABLE_STATUSES.has(task.status)).length;
  const errored = terminal.some(task => task.status === 'error');
  const cancelled = terminal.some(task => task.status === 'cancelled');
  const done = active.length === 0 && terminal.length > 0 && terminal.every(task => task.status === 'done');

  return {
    active,
    terminal,
    focusTasks,
    progress: Math.max(0, Math.min(100, progress || 0)),
    downloaded,
    totalBytes,
    speed,
    eta,
    pausedCount,
    queuedCount,
    retryingCount,
    pausableCount,
    errored,
    cancelled,
    done
  };
}

function getLimitBadge(tasks) {
  const limited = tasks.find(task => (task.speedLimitKbps || task.speedPolicy?.effectiveSpeedLimitKbps || 0) > 0);
  if (!limited) {
    const modeOnly = tasks.find(task => task.speedPolicy?.speedMode?.label);
    return modeOnly?.speedPolicy?.speedMode?.label || '';
  }
  const kbps = limited.speedLimitKbps || limited.speedPolicy?.effectiveSpeedLimitKbps || 0;
  const speedText = kbps >= 1024 ? `${(kbps / 1024).toFixed(kbps % 1024 === 0 ? 0 : 1)} MB/s` : `${kbps} KB/s`;
  const modeLabel = limited.speedPolicy?.speedMode?.label;
  return modeLabel ? `${modeLabel} ${speedText}` : `Limit ${speedText}`;
}

function render(tasks) {
  latestTasks = Array.isArray(tasks) ? tasks : [];
  const data = aggregate(latestTasks);
  const first = data.focusTasks[0];

  card.className = 'hud-card';
  badgeEl.classList.remove('show');

  if (!first) {
    titleEl.textContent = 'MIXDM';
    subtitleEl.textContent = 'Waiting for downloads';
    iconSymbol.textContent = '↓';
    fillEl.style.width = '0%';
    sizeEl.textContent = '-';
    speedEl.textContent = '-';
    primaryBtn.textContent = 'Pause';
    primaryAction = 'pause';
    return;
  }

  if (data.done) {
    card.classList.add('done');
    titleEl.textContent = data.terminal.length > 1 ? 'Downloads complete' : 'Download complete';
    subtitleEl.textContent = data.terminal.length > 1 ? `${data.terminal.length} files finished` : taskLabel(first, 'Finished');
    iconSymbol.textContent = '✓';
    primaryBtn.textContent = 'Folder';
    primaryAction = 'open-folder';
  } else if (data.errored) {
    card.classList.add('error');
    titleEl.textContent = 'Download failed';
    subtitleEl.textContent = first.errorMessage || 'Check MIXDM for details';
    iconSymbol.textContent = '!';
    primaryBtn.textContent = 'Open';
    primaryAction = 'open-main';
  } else if (data.cancelled && data.active.length === 0) {
    card.classList.add('error');
    titleEl.textContent = 'Download cancelled';
    subtitleEl.textContent = 'No active downloads';
    iconSymbol.textContent = '×';
    primaryBtn.textContent = 'Open';
    primaryAction = 'open-main';
  } else {
    const allPaused = data.active.length > 0 && data.pausedCount > data.pausableCount;
    const onlyQueued = data.active.length > 0 && data.queuedCount === data.active.length;
    const onlyRetrying = data.active.length > 0 && data.retryingCount === data.active.length;
    if (allPaused || onlyQueued || onlyRetrying) card.classList.add('paused');
    iconSymbol.textContent = allPaused ? 'Ⅱ' : '↓';
    if (onlyQueued) iconSymbol.textContent = 'Q';
    if (onlyRetrying) iconSymbol.textContent = 'R';
    titleEl.textContent = data.active.length === 1
      ? taskLabel(first, 'Downloading')
      : `Downloading ${data.active.length} files`;
    subtitleEl.textContent = onlyQueued
      ? `${data.active.length} waiting in queue`
      : onlyRetrying
      ? `${data.active.length} retrying soon`
      : `${data.progress.toFixed(0)}% - ${allPaused ? 'Paused' : fmtETA(data.eta)}`;
    primaryAction = onlyQueued || onlyRetrying ? 'open-main' : (allPaused ? 'resume' : 'pause');
    primaryBtn.textContent = onlyQueued || onlyRetrying ? 'Open' : (allPaused ? 'Resume' : 'Pause');
  }

  fillEl.style.width = `${data.progress}%`;
  const onlyQueuedFooter = data.active.length > 0 && data.queuedCount === data.active.length;
  const onlyRetryingFooter = data.active.length > 0 && data.retryingCount === data.active.length;
  sizeEl.textContent = onlyRetryingFooter
    ? `Retry ${first.retryAttempt || 1}/${first.retryMaxAttempts || '?'}`
    : onlyQueuedFooter
    ? (first.queuePosition ? `Queue #${first.queuePosition}` : 'Queued')
    : data.totalBytes > 0
    ? `${fmtBytes(data.downloaded)} of ${fmtBytes(data.totalBytes)}`
    : `${data.progress.toFixed(0)}%`;
  speedEl.textContent = fmtSpeed(data.speed);

  const badge = getLimitBadge(data.focusTasks);
  if (badge) {
    badgeEl.textContent = badge;
    badgeEl.classList.add('show');
  }
}

async function runAction(action) {
  if (!window.hudAPI) return;
  await window.hudAPI.action(action);
}

primaryBtn.addEventListener('click', () => runAction(primaryAction));
cancelBtn.addEventListener('click', () => runAction('cancel'));
openMainBtn.addEventListener('click', () => runAction('open-main'));

if (window.hudAPI) {
  window.hudAPI.onTasksUpdated(render);
}

render([]);
