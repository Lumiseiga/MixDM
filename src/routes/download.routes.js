const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { manager, createHttpTask } = require('../services/download.service');
const { ytTasks } = require('../services/ytdlp.service');
const { checkSafety, sanitizeFilename } = require('../services/safety.service');
const { DOWNLOADS_DIR } = require('../utils/file');
const { serverEvents } = require('../utils/events');
const { applySpeedPolicy, getQuotaStatus } = require('../services/speedQuota.service');
const { resolveSpeedMode } = require('../services/speedMode.service');
const { applyConnectionPolicy } = require('../services/connectionPolicy.service');
const { enqueueTask, removeFromQueue, processQueue } = require('../services/queue.service');
const { clearRetry } = require('../services/retry.service');

const router = express.Router();

function getActiveDownloadsDir() {
  try {
    const { getSettings } = require('../../settings');
    return getSettings().downloadsDir || DOWNLOADS_DIR;
  } catch (_) {
    return DOWNLOADS_DIR;
  }
}

function isPathInside(parentDir, targetPath) {
  const parent = path.resolve(parentDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(parent, target);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveDownloadFile(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    const err = new Error('File path is required');
    err.statusCode = 400;
    throw err;
  }

  const targetPath = path.resolve(filePath);

  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
    const err = new Error('File not found');
    err.statusCode = 404;
    throw err;
  }

  const downloadsDir = getActiveDownloadsDir();
  const basePath = fs.existsSync(downloadsDir)
    ? fs.realpathSync(downloadsDir)
    : path.resolve(downloadsDir);
  const realTargetPath = fs.realpathSync(targetPath);
  if (!isPathInside(basePath, realTargetPath)) {
    const err = new Error('Access denied: file is outside the downloads directory');
    err.statusCode = 403;
    throw err;
  }

  return realTargetPath;
}

async function openWithShell(action, targetPath) {
  try {
    const { shell } = require('electron');
    if (action === 'show') {
      shell.showItemInFolder(targetPath);
      return;
    }
    const error = await shell.openPath(targetPath);
    if (error) throw new Error(error);
    return;
  } catch (err) {
    if (process.platform !== 'win32') throw err;
  }

  const args = action === 'show' ? [`/select,${targetPath}`] : [targetPath];
  const child = spawn('explorer.exe', args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
}

// Get all tasks (HTTP + yt-dlp)
router.get('/tasks', (req, res) => {
  const httpTasks = manager.getAllTasks();
  const ytTaskList = [...ytTasks.values()].map(t => t.toJSON());
  res.json([...httpTasks, ...ytTaskList]);
});

router.get('/quota/status', (req, res) => {
  res.json(getQuotaStatus(req.userEmail));
});

// Start a new HTTP download
router.post('/tasks', async (req, res) => {
  const { url, filename: rawFilename, segments = 16, imageFormat = 'original', speedLimitKbps = 0, speedMode, headers, bypassSafety } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  // Sanitize filename to prevent directory traversal
  const filename = rawFilename ? sanitizeFilename(rawFilename) : undefined;

  if (!bypassSafety) {
    const safety = checkSafety(url, filename);
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
  const connectionPolicy = applyConnectionPolicy({
    userEmail: req.userEmail,
    requestedSegments: segments,
    imageFormat
  });
  const task = createHttpTask({
    url,
    filename,
    segments: connectionPolicy.effectiveSegments,
    imageFormat,
    speedLimitKbps: speedPolicy.effectiveSpeedLimitKbps,
    headers,
    speedPolicy,
    connectionPolicy
  });
  enqueueTask(task);
  serverEvents.emit('download-started', task.toJSON());
  res.json(task.toJSON());
});

// Pause a task
router.post('/tasks/:id/pause', (req, res) => {
  const ok = manager.pauseTask(req.params.id);
  if (ok) {
    const task = manager.getTask(req.params.id);
    res.json({ success: true, task: task.toJSON() });
  }
  else res.status(400).json({ error: 'Cannot pause this task' });
});

// Resume a task
router.post('/tasks/:id/resume', async (req, res) => {
  const task = manager.getTask(req.params.id);
  if (task && task.status === 'queued') {
    processQueue();
    return res.json({ success: true, task: task.toJSON() });
  }
  const ok = await manager.resumeTask(req.params.id);
  if (ok) {
    const task = manager.getTask(req.params.id);
    res.json({ success: true, task: task.toJSON() });
  }
  else res.status(400).json({ error: 'Cannot resume this task' });
});

// Cancel a task
router.post('/tasks/:id/cancel', (req, res) => {
  clearRetry(req.params.id);
  const ok = manager.cancelTask(req.params.id);
  if (ok) {
    const task = manager.getTask(req.params.id);
    res.json({ success: true, task: task.toJSON() });
  }
  else res.status(400).json({ error: 'Cannot cancel this task' });
});

// Remove a task
router.delete('/tasks/:id', (req, res) => {
  const task = manager.getTask(req.params.id);
  const snapshot = task ? task.toJSON() : null;
  clearRetry(req.params.id);
  removeFromQueue(req.params.id);
  manager.removeTask(req.params.id);
  if (snapshot && !['done', 'error', 'cancelled'].includes(snapshot.status)) {
    serverEvents.emit('download-task-updated', {
      ...snapshot,
      status: 'cancelled',
      speed: 0,
      eta: null,
      endTime: Date.now()
    });
  }
  processQueue();
  res.json({ success: true });
});

// Get single task status
router.get('/tasks/:id', (req, res) => {
  const task = manager.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task.toJSON());
});

// Refresh a task's URL (Address Refresh)
router.post('/tasks/:id/refresh-url', async (req, res) => {
  const { url, force } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const safety = checkSafety(url);
  if (!safety.safe) {
    return res.status(400).json({
      safetyWarning: true,
      error: safety.message
    });
  }

  try {
    await manager.refreshTaskUrl(req.params.id, url, !!force);
    await manager.resumeTask(req.params.id);
    const task = manager.getTask(req.params.id);
    res.json({ success: true, task: task.toJSON() });
  } catch (err) {
    const isSizeMismatch = err.message.includes('SIZE_MISMATCH');
    if (isSizeMismatch) {
      return res.status(409).json({
        sizeMismatch: true,
        error: err.message
      });
    }
    res.status(400).json({ error: err.message });
  }
});

// Open downloads folder in Explorer
router.post('/open-folder', async (req, res) => {
  try {
    const { filePath } = req.body;
    if (filePath) {
      await openWithShell('show', resolveDownloadFile(filePath));
    } else {
      const dir = path.resolve(getActiveDownloadsDir());
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const child = spawn('explorer.exe', [dir], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
    }
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// GET all files inside active downloads directory
router.get('/files', (req, res) => {
  const dir = getActiveDownloadsDir();

  try {
    if (!fs.existsSync(dir)) {
      return res.json([]);
    }

    const files = fs.readdirSync(dir);
    const fileList = [];

    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          fileList.push({
            name: file,
            path: filePath,
            size: stat.size,
            mtime: stat.mtimeMs,
            birthtime: stat.birthtimeMs
          });
        }
      } catch (_) {}
    }

    // Sort by modified time descending (newest first)
    fileList.sort((a, b) => b.mtime - a.mtime);
    res.json(fileList);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST open a file with default system application
router.post('/open-file', async (req, res) => {
  try {
    await openWithShell('open', resolveDownloadFile(req.body.filePath));
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// DELETE a file from the disk
router.delete('/files', (req, res) => {
  try {
    const filePath = resolveDownloadFile(req.body.filePath);
    fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

module.exports = router;
