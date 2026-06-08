const { getSettings } = require('../../settings');
const { manager, startExistingHttpTask } = require('./download.service');
const { ytTasks, ytdlpEvents, startExistingYtdlpTask } = require('./ytdlp.service');

const queuedIds = [];
const ACTIVE_SLOT_STATUSES = new Set([
  'retrying',
  'starting',
  'analyzing',
  'downloading',
  'merging',
  'extracting',
  'paused',
  'pausing',
  'resuming'
]);
const TERMINAL_STATUSES = new Set(['done', 'error', 'cancelled']);

function maxConcurrentDownloads() {
  const value = Number(getSettings().maxConcurrentDownloads) || 2;
  return Math.max(1, Math.min(Math.round(value), 10));
}

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

function updateQueuePositions() {
  queuedIds.forEach((id, index) => {
    const task = getTask(id);
    if (!task) return;
    const nextPosition = index + 1;
    if (task.queuePosition !== nextPosition) {
      task.queuePosition = nextPosition;
      emitTask(task);
    }
  });
}

function activeSlotCount() {
  const httpActive = manager.getAllTasks()
    .filter(task => ACTIVE_SLOT_STATUSES.has(task.status)).length;
  const ytActive = [...ytTasks.values()]
    .filter(task => ACTIVE_SLOT_STATUSES.has(task.status)).length;
  return httpActive + ytActive;
}

function startTask(task) {
  if (!task || !['queued', 'retrying'].includes(task.status)) return false;
  task.status = 'starting';
  task.queuePosition = null;
  emitTask(task);

  if (task.type === 'ytdlp' || String(task.id).startsWith('yt_')) {
    startExistingYtdlpTask(task.id);
  } else {
    startExistingHttpTask(task.id);
  }
  return true;
}

function processQueue() {
  let available = maxConcurrentDownloads() - activeSlotCount();
  while (available > 0 && queuedIds.length > 0) {
    const id = queuedIds.shift();
    const task = getTask(id);
    if (!task || task.status !== 'queued') {
      continue;
    }
    if (startTask(task)) {
      available -= 1;
    }
  }
  updateQueuePositions();
}

function enqueueTask(task) {
  if (!task) return null;
  if (!queuedIds.includes(task.id)) {
    queuedIds.push(task.id);
  }
  task.status = 'queued';
  task.queuePosition = queuedIds.indexOf(task.id) + 1;
  task.errorMessage = '';
  task.speed = 0;
  task.eta = null;
  emitTask(task);
  processQueue();
  return task;
}

function removeFromQueue(id) {
  const index = queuedIds.indexOf(id);
  if (index !== -1) {
    queuedIds.splice(index, 1);
    updateQueuePositions();
  }
}

function handleTaskUpdate(taskData) {
  if (!taskData || !taskData.id) return;
  if (TERMINAL_STATUSES.has(taskData.status)) {
    removeFromQueue(taskData.id);
    processQueue();
  }
}

function getQueueSnapshot() {
  return queuedIds.map((id, index) => ({
    id,
    position: index + 1,
    task: getTask(id)?.toJSON?.() || null
  })).filter(item => item.task);
}

module.exports = {
  enqueueTask,
  processQueue,
  removeFromQueue,
  handleTaskUpdate,
  getQueueSnapshot,
  ACTIVE_SLOT_STATUSES
};
