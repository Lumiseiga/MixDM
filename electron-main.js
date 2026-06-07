const path = require('path');
require('./console-safe').installSafeConsole();
const { app, BrowserWindow, dialog, Menu, shell, session, Tray, nativeImage, ipcMain, screen } = require('electron');
const { autoUpdater } = require('electron-updater');

let serverHandle = null;
let stopServer = null;
let serverEvents = null;
let tray = null;
let mainWindow = null;
let hudWindow = null;
let currentAppUrl = null;
let isQuitting = false;
const hudTasks = new Map();
let hudHideTimer = null;
let hudSnapshotTimer = null;
let lastHudSnapshotAt = 0;

const HUD_WIDTH = 344;
const HUD_HEIGHT = 124;
const HUD_MARGIN = 18;
const HUD_UPDATE_INTERVAL_MS = 250;
const HUD_ACTIVE_STATUSES = new Set(['queued', 'retrying', 'starting', 'analyzing', 'downloading', 'merging', 'extracting', 'paused', 'pausing', 'resuming']);
const HUD_THROTTLED_STATUSES = new Set(['downloading', 'merging', 'extracting']);

// ────────────────────────────────────────────
// Auto-launch helpers
// ────────────────────────────────────────────
function getAutoLaunchEnabled() {
  return app.getLoginItemSettings().openAtLogin;
}

function setAutoLaunch(enabled) {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    // On Windows: launch minimized (hidden) when starting with the system
    openAsHidden: true,
    // Use the app's executable path
    path: process.execPath,
    args: ['--autostart'],
  });
}

// Check if this launch was triggered by Windows startup
const isAutoStart = process.argv.includes('--autostart');

function setRuntimePaths() {
  process.env.MIXDM_USER_DATA_DIR = app.getPath('userData');
  process.env.MIXDM_TEMP_DIR = path.join(app.getPath('userData'), 'tmp');
}

async function ensureServer() {
  if (serverHandle) return serverHandle;

  setRuntimePaths();
  const server = require('./src/server');
  stopServer = server.stopServer;
  serverEvents = server.serverEvents;
  try {
    serverHandle = await server.startServer({
      host: '127.0.0.1',
      port: 3737,
      enableClipboardMonitor: true,
    });
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      const existingUrl = 'http://127.0.0.1:3737';
      const response = await fetch(`${existingUrl}/api/config`).catch(() => null);
      if (response && response.ok) {
        serverHandle = { url: existingUrl, port: 3737, server: null };
        stopServer = null;
        return serverHandle;
      }
    }
    throw err;
  }

  return serverHandle;
}

function getTrayIcon() {
  // Try to load a custom icon from public folder, fallback to a generated one
  const iconPaths = [
    path.join(__dirname, 'public', 'favicon.ico'),
    path.join(__dirname, 'public', 'icon.ico'),
    path.join(__dirname, 'public', 'icon.png'),
    path.join(__dirname, 'public', 'favicon.png'),
  ];

  for (const iconPath of iconPaths) {
    try {
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) return img;
    } catch (_) {}
  }

  // Fallback: create a simple colored square icon (16x16 PNG, blue-ish)
  // This is a minimal valid 16x16 PNG with MIXDM brand color (#6366f1 indigo)
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABmJLR0QA/wD/AP+gvaeTAAAA' +
    'eklEQVQ4jWNgGAWkAkYGBob/DAwM/6mggf8MDAxMgxoGAABjAAIAAP//AwBQSwECFAAUAAAA' +
    'CAAA8L5YWQAAAAAAAAAAAAAAACQAAAAAAAAAAAAQAO0BAAAAUG5nSW1hZ2UAUEsDBAoAAAAI' +
    'AADwvlhZAAAAAAAAAAAAAAAAFAAAAA==';

  // Use a simple 16x16 Data URI approach - create from raw RGBA data
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const x = i % size;
    const y = Math.floor(i / size);
    const inCircle = Math.pow(x - 7.5, 2) + Math.pow(y - 7.5, 2) < 49;
    buf[i * 4 + 0] = inCircle ? 99 : 0;   // R
    buf[i * 4 + 1] = inCircle ? 102 : 0;  // G
    buf[i * 4 + 2] = inCircle ? 241 : 0;  // B (#6366f1 indigo)
    buf[i * 4 + 3] = inCircle ? 255 : 0;  // A
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

// ────────────────────────────────────────────
// Auto-update
// ────────────────────────────────────────────
function setupAutoUpdater() {
  // Auto-update only works in a packaged (built) app, not in dev mode
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    console.log(`[Updater] มีอัปเดตใหม่: v${info.version}`);
    if (tray && process.platform === 'win32') {
      tray.displayBalloon({
        iconType: 'info',
        title: 'MIXDM — กำลังดาวน์โหลดอัปเดต',
        content: `กำลังดาวน์โหลด MIXDM v${info.version} อยู่เบื้องหลัง...`,
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[Updater] โปรแกรมเป็นเวอร์ชันล่าสุดแล้ว');
  });

  autoUpdater.on('download-progress', (progress) => {
    const pct = Math.round(progress.percent);
    console.log(`[Updater] ดาวน์โหลด: ${pct}% (${progress.bytesPerSecond} B/s)`);
    if (tray) tray.setToolTip(`MIXDM — กำลังอัปเดต ${pct}%`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[Updater] ดาวน์โหลดเสร็จ: v${info.version}`);
    if (tray) tray.setToolTip('MIXDM — Download Manager');

    const choice = dialog.showMessageBoxSync(mainWindow || undefined, {
      type: 'info',
      title: 'อัปเดต MIXDM พร้อมแล้ว',
      message: `MIXDM v${info.version} พร้อมติดตั้งแล้ว`,
      detail: 'รีสตาร์ตโปรแกรมเพื่อติดตั้งอัปเดตได้เลย\nหรือเลือก "ภายหลัง" เพื่อให้ติดตั้งอัตโนมัติเมื่อปิดโปรแกรมครั้งถัดไป',
      buttons: ['รีสตาร์ตตอนนี้', 'ภายหลัง'],
      defaultId: 0,
      cancelId: 1,
    });

    if (choice === 0) {
      isQuitting = true;
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('[Updater] เกิดข้อผิดพลาด:', err.message);
  });

  // ตรวจสอบครั้งแรกหลังเปิดแอป 15 วินาที
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 15_000);

  // ตรวจซ้ำทุก 6 ชั่วโมง
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1_000);
}

function buildTrayMenu(appUrl) {
  const autoLaunchEnabled = getAutoLaunchEnabled();

  return Menu.buildFromTemplate([
    {
      label: 'เปิด MIXDM',
      click: () => showWindow(appUrl),
    },
    { type: 'separator' },
    {
      label: 'เปิดอัตโนมัติเมื่อเปิดคอม',
      type: 'checkbox',
      checked: autoLaunchEnabled,
      click: (menuItem) => {
        setAutoLaunch(menuItem.checked);
        tray.setContextMenu(buildTrayMenu(appUrl));
      },
    },
    { type: 'separator' },
    {
      label: 'ตรวจสอบอัปเดต...',
      click: async () => {
        if (!app.isPackaged) {
          dialog.showMessageBox({
            type: 'info',
            title: 'MIXDM Updater',
            message: 'ระบบอัปเดตอัตโนมัติทำงานเฉพาะกับเวอร์ชัน build เท่านั้น',
            detail: 'รัน npm run build แล้วติดตั้ง .exe เพื่อทดสอบฟีเจอร์นี้',
          });
          return;
        }
        try {
          const result = await autoUpdater.checkForUpdates();
          if (!result || !result.updateInfo) {
            dialog.showMessageBox({
              type: 'info',
              title: 'MIXDM Updater',
              message: 'โปรแกรมเป็นเวอร์ชันล่าสุดแล้ว ✓',
              detail: `เวอร์ชันปัจจุบัน: v${app.getVersion()}`,
            });
          }
        } catch (err) {
          dialog.showMessageBox({
            type: 'error',
            title: 'ตรวจสอบอัปเดตไม่ได้',
            message: 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์อัปเดตได้',
            detail: err.message,
          });
        }
      },
    },
    { type: 'separator' },
    {
      label: 'ออกจากโปรแกรม',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray(appUrl) {
  const icon = getTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('MIXDM — Download Manager');
  tray.setContextMenu(buildTrayMenu(appUrl));

  // Double-click to show/restore window
  tray.on('double-click', () => showWindow(appUrl));
}

function showWindow(appUrl) {
  currentAppUrl = appUrl || currentAppUrl;
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(currentAppUrl);
  } else {
    mainWindow.show();
    mainWindow.focus();
    if (mainWindow.isMinimized()) mainWindow.restore();
  }
}

function positionHudWindow() {
  if (!hudWindow || hudWindow.isDestroyed()) return;
  const { workArea } = screen.getPrimaryDisplay();
  const x = Math.round(workArea.x + workArea.width - HUD_WIDTH - HUD_MARGIN);
  const y = Math.round(workArea.y + workArea.height - HUD_HEIGHT - HUD_MARGIN);
  hudWindow.setBounds({ x, y, width: HUD_WIDTH, height: HUD_HEIGHT });
}

function createHudWindow(appUrl) {
  if (hudWindow && !hudWindow.isDestroyed()) return hudWindow;
  hudWindow = new BrowserWindow({
    width: HUD_WIDTH,
    height: HUD_HEIGHT,
    minWidth: HUD_WIDTH,
    minHeight: HUD_HEIGHT,
    maxWidth: HUD_WIDTH,
    maxHeight: HUD_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  hudWindow.setAlwaysOnTop(true, 'floating');
  hudWindow.on('closed', () => {
    hudWindow = null;
  });
  hudWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const filename = path.basename(sourceId || '');
    console.log(`[HUD Console] [Lvl:${level}] ${message} (${filename}:${line})`);
  });
  hudWindow.webContents.on('did-finish-load', () => {
    sendHudSnapshot();
  });
  positionHudWindow();
  hudWindow.loadURL(`${appUrl}/hud.html`);
  return hudWindow;
}

function getHudTaskSnapshot() {
  return Array.from(hudTasks.values()).sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
}

function sendHudSnapshot() {
  if (!hudWindow || hudWindow.isDestroyed()) return;
  if (hudSnapshotTimer) {
    clearTimeout(hudSnapshotTimer);
    hudSnapshotTimer = null;
  }
  lastHudSnapshotAt = Date.now();
  hudWindow.webContents.send('hud-tasks-updated', getHudTaskSnapshot());
}

function scheduleHudSnapshot(immediate = false) {
  if (!hudWindow || hudWindow.isDestroyed()) return;
  if (immediate) {
    sendHudSnapshot();
    return;
  }

  const elapsed = Date.now() - lastHudSnapshotAt;
  if (elapsed >= HUD_UPDATE_INTERVAL_MS) {
    sendHudSnapshot();
    return;
  }

  if (!hudSnapshotTimer) {
    hudSnapshotTimer = setTimeout(() => sendHudSnapshot(), HUD_UPDATE_INTERVAL_MS - elapsed);
  }
}

function shouldShowHud() {
  try {
    const { getSettings } = require('./settings');
    return getSettings().showMiniHud !== false;
  } catch (_) {
    return true;
  }
}

function showHud(appUrl) {
  if (!shouldShowHud()) return;
  const win = createHudWindow(appUrl || currentAppUrl);
  positionHudWindow();
  if (typeof win.showInactive === 'function') {
    win.showInactive();
  } else {
    win.show();
  }
}

function updateHudTask(taskData, appUrl) {
  if (!taskData || !taskData.id) return;
  const previous = hudTasks.get(taskData.id);
  hudTasks.set(taskData.id, taskData);
  const statusChanged = previous?.status !== taskData.status;
  const importantUpdate = statusChanged || !HUD_THROTTLED_STATUSES.has(taskData.status);

  const tasks = getHudTaskSnapshot();
  const hasActive = tasks.some(task => HUD_ACTIVE_STATUSES.has(task.status));
  const hasRecentTerminal = tasks.some(task => ['done', 'error', 'cancelled'].includes(task.status));

  if (hudHideTimer && hasActive) {
    clearTimeout(hudHideTimer);
    hudHideTimer = null;
  }

  if (hasActive || hasRecentTerminal) {
    showHud(appUrl);
  } else {
    scheduleHudSnapshot(importantUpdate);
  }
  scheduleHudSnapshot(importantUpdate);

  if (!hasActive && hasRecentTerminal) {
    clearTimeout(hudHideTimer);
    hudHideTimer = setTimeout(() => {
      if (hudWindow && !hudWindow.isDestroyed()) hudWindow.hide();
      for (const [id, task] of hudTasks) {
        if (!HUD_ACTIVE_STATUSES.has(task.status)) hudTasks.delete(id);
      }
    }, 3000);
  }
}

function setYtTaskStatus(task, status) {
  const { ytdlpEvents } = require('./src/services/ytdlp.service');
  if (task._controller && (status === 'paused' || status === 'cancelled')) {
    task._controller.cancel();
  }
  task.status = status;
  task.speed = 0;
  task.speedStr = '';
  task.eta = null;
  task.etaStr = '';
  if (status === 'cancelled') task.endTime = Date.now();
  ytdlpEvents.emit('task-updated', task.toJSON());
}

async function handleHudAction(action) {
  const { manager } = require('./src/services/download.service');
  const { ytTasks, resumeYtdlpTask } = require('./src/services/ytdlp.service');
  const tasks = getHudTaskSnapshot();
  const candidates = tasks.filter(task => HUD_ACTIVE_STATUSES.has(task.status));

  if (action === 'open-main') {
    showWindow(currentAppUrl);
    return { success: true };
  }

  if (action === 'open-folder') {
    const { getSettings } = require('./settings');
    const { DOWNLOADS_DIR } = require('./src/utils/file');
    const dir = getSettings().downloadsDir || DOWNLOADS_DIR;
    await shell.openPath(dir);
    return { success: true };
  }

  for (const task of candidates) {
    const isYt = task.type === 'ytdlp' || String(task.id).startsWith('yt_');
    if (isYt) {
      const ytTask = ytTasks.get(task.id);
      if (!ytTask) continue;
      if (action === 'pause' && ['analyzing', 'downloading', 'merging', 'extracting'].includes(task.status)) {
        setYtTaskStatus(ytTask, 'paused');
      } else if (action === 'resume' && task.status === 'paused') {
        resumeYtdlpTask(task.id);
      } else if (action === 'cancel') {
        setYtTaskStatus(ytTask, 'cancelled');
      }
    } else {
      if (action === 'pause' && ['analyzing', 'downloading', 'merging', 'extracting'].includes(task.status)) {
        manager.pauseTask(task.id);
      } else if (action === 'resume' && task.status === 'paused') {
        await manager.resumeTask(task.id);
      } else if (action === 'cancel') {
        manager.cancelTask(task.id);
      }
    }
  }

  return { success: true };
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 920,
    minHeight: 640,
    backgroundColor: '#08090c',
    title: 'MIXDM',
    frame: false, // frameless window
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const filename = path.basename(sourceId || '');
    console.log(`[Browser Console] [Lvl:${level}] ${message} (${filename}:${line})`);
  });

  mainWindow.once('ready-to-show', () => {
    // If launched automatically at startup, start hidden in tray
    if (isAutoStart) {
      mainWindow.hide();
    } else {
      mainWindow.show();
    }
  });

  // Intercept window close — hide to tray instead of quitting
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      // Show a balloon notification the first time (Windows only)
      if (tray && process.platform === 'win32') {
        tray.displayBalloon({
          iconType: 'info',
          title: 'MIXDM ยังทำงานอยู่',
          content: 'MIXDM ทำงานอยู่เบื้องหลัง คลิกสองครั้งที่ไอคอนเพื่อเปิดอีกครั้ง',
        });
      }
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    shell.openExternal(targetUrl);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (!targetUrl.startsWith(url)) {
      event.preventDefault();
      shell.openExternal(targetUrl);
    }
  });

  mainWindow.loadURL(url);
}

// ── Window Controls IPC Handlers ────────────────────────────
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('window-is-maximized', () => {
  return mainWindow ? mainWindow.isMaximized() : false;
});

ipcMain.handle('select-directory', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'เลือกโฟลเดอร์สำหรับดาวน์โหลด (Select Download Folder)',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('hud-action', async (_event, action) => {
  try {
    return await handleHudAction(action);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'notifications');
  });

  const { url } = await ensureServer();
  currentAppUrl = url;
  createWindow(url);
  createTray(url);
  setupAutoUpdater();

  if (serverEvents) {
    serverEvents.on('focus-window', () => showWindow(url));
    serverEvents.on('download-started', (taskData) => updateHudTask(taskData, url));
    serverEvents.on('download-task-updated', (taskData) => updateHudTask(taskData, url));
  }

  app.on('activate', () => {
    showWindow(url);
  });
}).catch((err) => {
  dialog.showErrorBox('MIXDM failed to start', err && err.message ? err.message : String(err));
  app.quit();
});

app.on('before-quit', async () => {
  isQuitting = true;
  if (stopServer) {
    await stopServer();
  }
});

// Override default quit-on-all-windows-closed — tray keeps app alive
app.on('window-all-closed', () => {
  // Do NOT quit — let the tray handle it
  // On macOS we also skip quitting (handled by 'activate')
});
