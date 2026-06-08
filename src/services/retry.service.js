const { getSettings } = require('../../settings');
const { manager } = require('./download.service');
const { ytTasks, ytdlpEvents } = require('./ytdlp.service');

const retryTimers = new Map();

const NON_RETRYABLE_PATTERNS = [
  /401|unauthorized/i,
  /403|forbidden/i,
  /404|not found/i,
  /private/i,
  /sign in|login/i,
  /confirm your (identity|age)/i,
  /members-only/i,
  /copyright/i,
  /drm/i,
  /unsupported/i,
  /size_mismatch|size mismatch/i,
  /safety|ความปลอดภัย/i
];

const RETRYABLE_PATTERNS = [
  /timeout|timed out/i,
  /econnreset|connection reset/i,
  /econnrefused|connection refused/i,
  /etimedout/i,
  /eai_again/i,
  /enotfound|getaddrinfo|dns/i,
  /network/i,
  /failed to fetch/i,
  /socket/i,
  /http (408|429|500|502|503|504)/i,
  /temporar/i,
  /try again/i,
  /fragment/i
];

function getTask(id) {
  return manager.getTask(id) || ytTasks.get(id) || null;
}

function emitTask(task) {
  if (!task || typeof task.toJSON !== 'function') return;
  if (task.type === 'ytdlp' || String(task.id).startsWith('yt_')) {
    ytdlpEvents.emit('task-updated', task.toJSON());
  } else {
    manager._emit(task);
  }
}

function getRetrySettings() {
  const settings = getSettings();
  return {
    enabled: settings.smartRetryEnabled !== false,
    maxAttempts: Math.max(0, Math.min(Number(settings.smartRetryMaxAttempts) || 3, 10)),
    baseDelayMs: Math.max(1000, Math.min(Number(settings.smartRetryBaseDelayMs) || 5000, 60000))
  };
}

function isRetryableError(message) {
  const text = String(message || '');
  if (!text) return false;
  if (NON_RETRYABLE_PATTERNS.some(pattern => pattern.test(text))) return false;
  return RETRYABLE_PATTERNS.some(pattern => pattern.test(text));
}

function nextDelayMs(task, baseDelayMs) {
  const attempt = Number(task.retryAttempt) || 0;
  return Math.min(baseDelayMs * Math.max(1, attempt), 60000);
}

function clearRetry(id) {
  const timer = retryTimers.get(id);
  if (timer) clearTimeout(timer);
  retryTimers.delete(id);
}

function resetRetryState(task) {
  if (!task) return;
  clearRetry(task.id);
  task.retryNextAt = null;
  task.retryReason = '';
}

function scheduleRetry(taskData, enqueueTask) {
  if (!taskData || taskData.status !== 'error') return false;
  const settings = getRetrySettings();
  if (!settings.enabled || settings.maxAttempts <= 0) return false;

  const task = getTask(taskData.id);
  if (!task) return false;
  if (retryTimers.has(task.id)) return true;
  if (!isRetryableError(taskData.errorMessage || task.errorMessage)) return false;

  task.retryAttempt = (Number(task.retryAttempt) || 0) + 1;
  task.retryMaxAttempts = settings.maxAttempts;
  if (task.retryAttempt > settings.maxAttempts) {
    task.retryAttempt = settings.maxAttempts;
    return false;
  }

  const delayMs = nextDelayMs(task, settings.baseDelayMs);
  task.status = 'retrying';
  task.speed = 0;
  task.speedStr = '';
  task.eta = null;
  task.etaStr = '';
  task.retryReason = taskData.errorMessage || task.errorMessage || 'Temporary failure';
  task.retryNextAt = Date.now() + delayMs;
  emitTask(task);

  const timer = setTimeout(() => {
    retryTimers.delete(task.id);
    const freshTask = getTask(task.id);
    if (!freshTask || freshTask.status !== 'retrying') return;
    freshTask.retryNextAt = null;
    freshTask.errorMessage = '';
    enqueueTask(freshTask);
  }, delayMs);
  retryTimers.set(task.id, timer);
  return true;
}

module.exports = {
  scheduleRetry,
  resetRetryState,
  clearRetry,
  isRetryableError
};
