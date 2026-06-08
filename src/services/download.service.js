const { DownloadManager } = require('../../downloader');

const manager = new DownloadManager();

function createHttpTask({ url, filename, segments = 16, imageFormat = 'original', speedLimitKbps = 0, headers = null, speedPolicy = null, connectionPolicy = null }) {
  const parsedSegments = imageFormat && imageFormat !== 'original'
    ? 1
    : Math.max(1, Math.min(parseInt(segments, 10) || 16, 32));
  const task = manager.createTask(url, {
    filename: filename || undefined,
    segments: parsedSegments,
    imageFormat,
    speedLimitKbps: speedLimitKbps || 0,
    headers
  });
  task.speedPolicy = speedPolicy;
  task.connectionPolicy = connectionPolicy;
  return task;
}

function startExistingHttpTask(id) {
  const task = manager.getTask(id);
  if (!task) return null;
  if (task && ['queued', 'starting', 'retrying'].includes(task.status)) {
    task.status = 'idle';
  }
  manager.startTask(task.id).catch(err => {
    console.error(`Task ${task.id} error:`, err.message);
  });
  return task;
}

function startHttpTask(args) {
  const task = createHttpTask(args);
  startExistingHttpTask(task.id);
  return task;
}

module.exports = {
  manager,
  createHttpTask,
  startExistingHttpTask,
  startHttpTask
};
