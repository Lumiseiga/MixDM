/* ════════════════════════════════════════════════════
   MIXDM Frontend — downloads.js
   Core download logic, SSE connections, and tasks rendering
   ════════════════════════════════════════════════════ */

// ── Clipboard Monitor State ────────────────────────────────
let lastDetectedUrl = '';
let clipToastInterval = null;
let clipToastTimeout = null;
let clipToastTimeLeft = 8000;
let clipToastIsHovered = false;

function handleClipboardUrl(url) {
  if (!appSettings.clipboardMonitorEnabled) return;
  
  // Prevent duplicate prompt if URL is same as last detected or already in url input
  const currentInput = $('url-input').value.trim();
  if (url === lastDetectedUrl || url === currentInput) return;
  
  lastDetectedUrl = url;
  
  // System Notification if page is hidden
  if (document.hidden && appSettings.clipboardNotificationsEnabled && typeof Notification !== 'undefined') {
    if (Notification.permission === 'granted') {
      const n = new Notification('📋 MIXDM — Link Detected', {
        body: url,
        icon: '/favicon.ico',
        tag: 'mixdm-clip'
      });
      n.onclick = () => {
        window.focus();
        $('url-input').value = url;
        analyzeUrl();
        n.close();
      };
      return; // Skip in-app toast if system notification was triggered
    }
  }
  
  // In-app toast notification
  showClipToast(url);
}

function showClipToast(url) {
  const toastEl = $('clip-toast');
  const progress = $('clip-toast-progress');
  $('clip-toast-url').textContent = url;
  
  clipToastTimeLeft = 8000;
  clipToastIsHovered = false;
  progress.style.transform = 'scaleX(1)';
  toastEl.classList.add('show');
  
  clearInterval(clipToastInterval);
  clearTimeout(clipToastTimeout);
  
  clipToastInterval = setInterval(() => {
    if (!clipToastIsHovered) {
      clipToastTimeLeft -= 100;
      const pct = Math.max(0, clipToastTimeLeft / 8000);
      progress.style.transform = `scaleX(${pct})`;
      
      if (clipToastTimeLeft <= 0) {
        hideClipToast();
      }
    }
  }, 100);
}

function hideClipToast() {
  const toastEl = $('clip-toast');
  toastEl.classList.remove('show');
  clearInterval(clipToastInterval);
  clearTimeout(clipToastTimeout);
}

// ── Render Task Card ───────────────────────────────────────
function renderTask(task) {
  const el = document.getElementById(`task-${task.id}`);
  if (el) { updateTask(el, task); return; }
  const card = document.createElement('div');
  card.className = 'task-card' + (task.type === 'ytdlp' ? ' yt-card' : '');
  card.id = `task-${task.id}`;
  $('tasks-list').prepend(card);
  updateTask(card, task);
}

function updateTask(card, task) {
  const isYt = task.type === 'ytdlp';
  const pct = task.progress || 0;
  const segs = task.segments || [];
  const paused = task.status === 'paused';
  const done = task.status === 'done';
  const err = task.status === 'error';
  const queued = task.status === 'queued';
  const retrying = task.status === 'retrying';
  const merging = task.status === 'merging';
  const barClass = done ? 'done' : (paused || queued || retrying) ? 'paused' : err ? 'error' : isYt ? 'yt' : '';

  const statusClass = done ? 'done-card' : (paused || queued || retrying || task.status === 'pausing') ? 'paused-card' : (err || task.status === 'cancelled') ? 'error-card' : 'downloading-card';
  card.className = `task-card ${isYt ? 'yt-card' : ''} ${statusClass}`;

  const currentPending = task.pendingAction || '';
  const lastStatus = card.dataset.renderedStatus;
  const lastPending = card.dataset.renderedPending;

  if (lastStatus === task.status && lastPending === currentPending) {
    // ── Partial update to prevent button flickering and dropped click events ──
    const pb = card.querySelector('.progress-bar');
    if (pb) pb.style.width = pct + '%';

    const pt = card.querySelector('.progress-pct');
    if (pt) pt.textContent = pct.toFixed(1) + '%';

    const meta = card.querySelector('.task-meta');
    if (meta) {
      const platformBadgeHtml = isYt && task.platform
        ? `<span class="platform-badge ${platformCssClass(task.platform)}">${task.platform}</span>` : '';
      const queueBadgeHtml = task.status === 'queued'
        ? `<span>Queue #${task.queuePosition || '-'}</span>` : '';
      const retryBadgeHtml = task.status === 'retrying'
        ? `<span>Retry ${task.retryAttempt || 1}/${task.retryMaxAttempts || '?'}</span>` : '';
      const speedModeBadgeHtml = task.speedPolicy?.speedMode?.label
        ? `<span>${task.speedPolicy.speedMode.label}</span>` : '';

      let speedDisplay = '';
      if (task.status === 'downloading') {
        if (isYt && task.speedStr) {
          speedDisplay = `<span>${task.speedStr}</span>`;
        } else if (!isYt && task.speed > 0) {
          speedDisplay = `<span>${fmtSpeed(task.speed)}</span>`;
        }
      }

      let etaDisplay = '';
      if (task.status === 'downloading') {
        if (isYt && task.etaStr && task.etaStr !== 'Unknown') {
          etaDisplay = `<span>ETA: ${task.etaStr}</span>`;
        } else if (!isYt && task.eta) {
          etaDisplay = `<span>ETA: ${fmtETA(task.eta)}</span>`;
        }
      }

      let sizeDisplay = '';
      if (task.fileSize > 0) {
        const downloaded = isYt 
          ? Math.round(task.fileSize * (pct / 100))
          : (task.totalDownloaded || 0);
        sizeDisplay = `<span>${fmtBytes(downloaded)} / ${fmtBytes(task.fileSize)}</span>`;
      } else {
        const downloaded = isYt ? 0 : (task.totalDownloaded || 0);
        sizeDisplay = downloaded > 0 ? `<span>${fmtBytes(downloaded)} ${t('downloaded_label', 'downloaded')}</span>` : `<span>${t('size_unknown', 'Size unknown')}</span>`;
      }

      const doneInfo = done ? `<span title="${task.outputPath || downloadsDir}" style="cursor:pointer;color:var(--success)"
        onclick="openFolder('${(task.outputPath||'').replace(/\\/g,'\\\\')}')" >${t('click_to_open', '📁 Click to open file')}</span>` : '';

      let errorSpan = '';
      if (task.errorMessage) {
        errorSpan = `<span style="color:var(--danger)">${task.errorMessage}</span>`;
        const errLower = task.errorMessage.toLowerCase();
        const isAuthError = errLower.includes('sign in') || errLower.includes('login') || errLower.includes('confirm your identity') || errLower.includes('confirm your age') || errLower.includes('private') || errLower.includes('members-only') || errLower.includes('unavailable') || errLower.includes('cookies');
        if (isYt && isAuthError) {
          errorSpan += ` <a href="#" onclick="retryWithCookies(event, '${task.id}')" class="retry-cookies-link" style="color:var(--accent); margin-left:8px; text-decoration:underline; font-weight:bold; cursor:pointer;">${t('retry_with_cookies', 'Retry with cookies')}</a>`;
        }
      }

      meta.innerHTML = `
        ${platformBadgeHtml}
        ${queueBadgeHtml}
        ${retryBadgeHtml}
        ${speedModeBadgeHtml}
        ${sizeDisplay}
        ${speedDisplay}
        ${etaDisplay}
        ${doneInfo}
        ${errorSpan}
      `;
    }

    if (segs.length > 1) {
      const segFills = card.querySelectorAll('.seg-bar-fill');
      segs.forEach((seg, i) => {
        if (segFills[i]) {
          segFills[i].style.width = seg.progress + '%';
          segFills[i].className = `seg-bar-fill ${seg.status === 'done' ? 'done' : seg.status === 'paused' ? 'paused' : seg.status === 'error' ? 'error' : ''}`;
        }
      });

      const segDetailCells = card.querySelectorAll('.seg-cell');
      if (segDetailCells.length > 0) {
        segs.forEach((seg, i) => {
          const cell = segDetailCells[i];
          if (cell) {
            const fill = cell.querySelector('.seg-cell-fill');
            if (fill) fill.style.width = seg.progress + '%';
            const stats = cell.querySelector('.seg-cell-stats');
            if (stats) stats.textContent = `${seg.progress.toFixed(1)}% · ${fmtSpeed(seg.speed)}`;
          }
        });
      }
    }
    return;
  }

  // Set rendered state markers
  card.dataset.renderedStatus = task.status;
  card.dataset.renderedPending = currentPending;

  const statusIcons = {
    analyzing:   { icon: '🔍', pulse: true },
    downloading: { icon: isYt ? '▶️' : '⬇️', pulse: true },
    paused:      { icon: '⏸', pulse: false },
    merging:     { icon: '🔗', pulse: true },
    extracting:  { icon: '🔗', pulse: true },
    done:        { icon: '✅', pulse: false },
    error:       { icon: '❌', pulse: false },
    idle:        { icon: '⏳', pulse: false },
    cancelled:   { icon: '🚫', pulse: false },
    pausing:     { icon: '⏳', pulse: true },
    resuming:    { icon: '⏳', pulse: true }
  };
  statusIcons.queued = { icon: 'Q', pulse: false };
  statusIcons.starting = { icon: '...', pulse: true };
  statusIcons.retrying = { icon: 'R', pulse: true };
  let displayStatus = task.status;
  if (task.pendingAction === 'pause') displayStatus = 'pausing';
  if (task.pendingAction === 'resume') displayStatus = 'resuming';
  const si = statusIcons[displayStatus] || statusIcons.idle;

  const segBars = segs.length > 1 ? segs.map(seg =>
    `<div class="seg-bar">
      <div class="seg-bar-fill ${seg.status === 'done' ? 'done' : seg.status === 'paused' ? 'paused' : seg.status === 'error' ? 'error' : ''}"
           style="width:${seg.progress}%"></div>
    </div>`
  ).join('') : '';

  const segDetail = segs.map(seg =>
    `<div class="seg-cell">
      <div class="seg-cell-header">${isYt ? 'yt-dlp' : `Thread ${seg.index + 1}`}</div>
      <div class="seg-cell-bar">
        <div class="seg-cell-fill ${seg.status === 'done' ? 'done' : seg.status === 'error' || seg.status === 'cancelled' ? 'error' : ''}"
             style="width:${seg.progress}%"></div>
      </div>
      <div class="seg-cell-stats">${seg.progress.toFixed(1)}% · ${fmtSpeed(seg.speed)}</div>
    </div>`
  ).join('');

  const wasOpen = card.querySelector('.seg-detail-grid.open');

  // Thumbnail or icon
  const thumbHtml = isYt && task.thumbnail
    ? `<img class="task-thumbnail" src="${task.thumbnail}" alt="thumb" onerror="this.style.display='none'" />`
    : `<div class="task-icon" style="${iconBg(task.status, isYt)}">${fileIcon(task.filename, task.contentType, isYt)}</div>`;

  // Speed display
  let speedDisplay = '';
  if (task.status === 'downloading') {
    if (isYt && task.speedStr) {
      speedDisplay = `<span>${task.speedStr}</span>`;
    } else if (!isYt && task.speed > 0) {
      speedDisplay = `<span>${fmtSpeed(task.speed)}</span>`;
    }
  }

  // ETA display
  let etaDisplay = '';
  if (task.status === 'downloading') {
    if (isYt && task.etaStr && task.etaStr !== 'Unknown') {
      etaDisplay = `<span>ETA: ${task.etaStr}</span>`;
    } else if (!isYt && task.eta) {
      etaDisplay = `<span>ETA: ${fmtETA(task.eta)}</span>`;
    }
  }

  // Done info
  const doneInfo = done ? `<span title="${task.outputPath || downloadsDir}" style="cursor:pointer;color:var(--success)"
    onclick="openFolder('${(task.outputPath||'').replace(/\\/g,'\\\\')}')" >${t('click_to_open', '📁 Click to open file')}</span>` : '';

  // Platform badge for yt tasks
  const platformBadgeHtml = isYt && task.platform
    ? `<span class="platform-badge ${platformCssClass(task.platform)}">${task.platform}</span>` : '';
  const queueBadgeHtml = task.status === 'queued'
    ? `<span>Queue #${task.queuePosition || '-'}</span>` : '';
  const retryBadgeHtml = task.status === 'retrying'
    ? `<span>Retry ${task.retryAttempt || 1}/${task.retryMaxAttempts || '?'}</span>` : '';
  const speedModeBadgeHtml = task.speedPolicy?.speedMode?.label
    ? `<span>${task.speedPolicy.speedMode.label}</span>` : '';

  // Downloaded size display
  let sizeDisplay = '';
  if (task.fileSize > 0) {
    const downloaded = isYt 
      ? Math.round(task.fileSize * (task.progress / 100))
      : (task.totalDownloaded || 0);
    if (done) {
      sizeDisplay = `<span>${fmtBytes(task.fileSize)}</span>`;
    } else {
      sizeDisplay = `<span>${fmtBytes(downloaded)} / ${fmtBytes(task.fileSize)}</span>`;
    }
  } else {
    // If fileSize is unknown
    const downloaded = isYt ? 0 : (task.totalDownloaded || 0);
    sizeDisplay = downloaded > 0 ? `<span>${fmtBytes(downloaded)} ${t('downloaded_label', 'downloaded')}</span>` : `<span>${t('size_unknown', 'Size unknown')}</span>`;
  }

  // Control buttons (Pause/Stop, Resume, Open)
  let actionBtns = '';
  const activeStatus = ['downloading', 'merging', 'extracting', 'analyzing'];

  if (task.pendingAction) {
    if (task.pendingAction === 'pause') {
      actionBtns = `<button class="action-btn" disabled title="${t('stopping', 'Stopping...')}">⏳</button>`;
    } else if (task.pendingAction === 'resume') {
      actionBtns = `<button class="action-btn" disabled title="${t('resuming', 'Resuming...')}">⏳</button>`;
    } else if (task.pendingAction === 'remove') {
      actionBtns = `<button class="action-btn danger" disabled title="${t('removing', 'Removing...')}">⏳</button>`;
    }
  } else if (activeStatus.includes(task.status)) {
    if (isYt) {
      actionBtns = `<button class="action-btn" title="${t('status_pausing', 'Stopping...')}" onclick="pauseYtTask('${task.id}')">⏸</button>`;
    } else {
      actionBtns = `<button class="action-btn" title="${t('status_paused', 'Paused')}" onclick="pauseTask('${task.id}')">⏸</button>`;
    }
  } else if (task.status === 'queued' || task.status === 'retrying') {
    actionBtns = '';
  } else if (task.status === 'paused') {
    if (isYt) {
      actionBtns = `<button class="action-btn" title="${t('status_resuming', 'Resuming...')}" onclick="resumeYtTask('${task.id}')">▶</button>`;
    } else {
      actionBtns = `<button class="action-btn" title="${t('status_resuming', 'Resuming...')}" onclick="resumeTask('${task.id}')">▶</button>`;
    }
  } else if (task.status === 'done') {
    actionBtns = `<button class="action-btn" title="${t('s_open', 'Open')}" onclick="openFolder('${(task.outputPath||'').replace(/\\/g,'\\\\')}')">📂</button>`;
  } else if (task.status === 'error' && !isYt) {
    actionBtns = `<button class="action-btn" title="${t('refresh_title', 'Refresh Download URL')}" onclick="openRefreshUrlModal('${task.id}')">🔄</button>`;
  }

  card.innerHTML = `
    <div class="task-header">
      ${thumbHtml}
      <div class="task-info">
        <div class="task-name" title="${task.title || task.filename}">${task.title || task.filename || 'Analyzing...'}</div>
        <div class="task-meta">
          ${platformBadgeHtml}
          ${queueBadgeHtml}
          ${retryBadgeHtml}
          ${speedModeBadgeHtml}
          ${sizeDisplay}
          ${speedDisplay}
          ${etaDisplay}
          ${doneInfo}
          ${(() => {
            if (!task.errorMessage) return '';
            let errorSpan = `<span style="color:var(--danger)">${task.errorMessage}</span>`;
            const errLower = task.errorMessage.toLowerCase();
            const isAuthError = errLower.includes('sign in') || errLower.includes('login') || errLower.includes('confirm your identity') || errLower.includes('confirm your age') || errLower.includes('private') || errLower.includes('members-only') || errLower.includes('unavailable') || errLower.includes('cookies');
            if (isYt && isAuthError) {
              errorSpan += ` <a href="#" onclick="retryWithCookies(event, '${task.id}')" class="retry-cookies-link" style="color:var(--accent); margin-left:8px; text-decoration:underline; font-weight:bold; cursor:pointer;">${t('retry_with_cookies', 'Retry with cookies')}</a>`;
            }
            return errorSpan;
          })()}
        </div>
      </div>
      <div class="task-actions">
        <div class="status-badge ${displayStatus}">
          <span class="dot ${si.pulse ? 'pulse' : ''}"></span>
          ${t('status_' + displayStatus, displayStatus.charAt(0).toUpperCase() + displayStatus.slice(1))}
        </div>
        ${actionBtns}
        <button class="action-btn" title="Toggle Details" ${task.pendingAction ? 'disabled' : ''} onclick="toggleSegments('${task.id}')">≡</button>
        <button class="action-btn danger" title="Remove" ${task.pendingAction ? 'disabled' : ''} onclick="removeTask('${task.id}', ${isYt})">✕</button>
      </div>
    </div>

    <div class="progress-row">
      <div class="progress-bar-wrap">
        <div class="progress-bar ${barClass}" style="width:${pct}%"></div>
      </div>
      <div class="progress-pct">${pct.toFixed(1)}%</div>
    </div>

    ${segs.length > 1 ? `<div class="segments-wrap">${segBars}</div>` : ''}

    <div class="seg-detail-grid ${wasOpen ? 'open' : ''}" id="segs-${task.id}">
      ${segDetail}
    </div>
  `;
}

function toggleSegments(id) {
  const el = document.getElementById(`segs-${id}`);
  if (el) el.classList.toggle('open');
}

// ── Filter ────────────────────────────────────────────────
function filterTasks() {
  const all = [...tasks.values()];
  const historyTasks = all.filter(t => !isCurrentTask(t));
  const filtered = currentFilter === 'all' ? historyTasks : historyTasks.filter(t => {
    if (currentFilter === 'downloading') return false;
    if (currentFilter === 'paused') return t.status === 'paused';
    return t.status === currentFilter;
  });
  const filteredIds = new Set(filtered.map(task => task.id));
  for (const [id] of tasks) {
    const card = document.getElementById(`task-${id}`);
    if (!card) continue;
    const nextDisplay = filteredIds.has(id) ? '' : 'none';
    if (card.style.display !== nextDisplay) card.style.display = nextDisplay;
  }
  if (filtered.length === 1) {
    $('dl-count').textContent = t('download_count_single', '1 download');
  } else {
    $('dl-count').textContent = t('downloads_count', '{count} downloads').replace('{count}', filtered.length);
  }
  const emptyState = $('empty-state');
  emptyState.classList.toggle('show', filtered.length === 0);

  const emptyTitle = emptyState.querySelector('.empty-title');
  const emptySub = emptyState.querySelector('.empty-sub');
  if (emptyTitle && emptySub) {
    if (all.length > 0 && historyTasks.length === 0) {
      emptyTitle.textContent = 'No completed downloads yet';
      emptySub.textContent = 'Current downloads are shown in Downloading File Info.';
    } else {
      emptyTitle.textContent = t('no_downloads', 'No downloads yet');
      emptySub.textContent = t('no_downloads_sub', 'Paste a URL above — supports YouTube, direct file links, and more');
    }
  }
  updateStats();
}

// ── SSE Connection ─────────────────────────────────────────
let pendingTaskRenders = new Map();
let pendingRenderFrame = null;
let sseConnection = null;
let sseReconnectTimer = null;

function flushTaskRenders() {
  pendingRenderFrame = null;
  for (const task of pendingTaskRenders.values()) {
    renderTask(task);
  }
  pendingTaskRenders.clear();
  filterTasks();
}

function scheduleTaskRender(task) {
  if (!task || !task.id) return;
  pendingTaskRenders.set(task.id, task);
  if (!pendingRenderFrame) {
    pendingRenderFrame = requestAnimationFrame(flushTaskRenders);
  }
}

function connectSSE() {
  if (sseConnection) {
    sseConnection.close();
    sseConnection = null;
  }
  if (sseReconnectTimer) {
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }

  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  const sseUrl = token ? `/api/events?token=${encodeURIComponent(token)}` : '/api/events';
  const es = new EventSource(sseUrl);
  sseConnection = es;
  es.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'init') {
      data.tasks.forEach(t => { tasks.set(t.id, t); scheduleTaskRender(t); });
    } else if (data.type === 'clipboard-url') {
      handleClipboardUrl(data.url);
    } else {
      const existing = tasks.get(data.id);
      const wasDone = existing && existing.status === 'done';
      const isDone = data.status === 'done';
      if (existing && existing.pendingAction) {
        data.pendingAction = existing.pendingAction;
      }
      tasks.set(data.id, data);
      scheduleTaskRender(data);
      if (!wasDone && isDone) {
        playCompletionSound();
        showCompletionNotification(data);
      }
    }
  };
  es.onerror = () => {
    if (sseConnection === es) {
      es.close();
      sseConnection = null;
    }
    if (!sseReconnectTimer) {
      sseReconnectTimer = setTimeout(() => {
        sseReconnectTimer = null;
        connectSSE();
      }, 3000);
    }
  };
}

function playCompletionSound() {
  if (appSettings.completionSoundEnabled === false) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    
    // Play a sweet double-chime (indigo/mixdm brand theme!)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(659.25, now); // E5
    gain1.gain.setValueAtTime(0.08, now);
    gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.3);
    
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880.00, now + 0.12); // A5
    gain2.gain.setValueAtTime(0.08, now + 0.12);
    gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.12);
    osc2.stop(now + 0.45);
  } catch (err) {
    console.error('Failed to play completion sound:', err);
  }
}

function showCompletionNotification(task) {
  if (appSettings.clipboardNotificationsEnabled && typeof Notification !== 'undefined') {
    if (Notification.permission === 'granted') {
      const title = t('status_done', 'Done') + ': ' + (task.title || task.filename || 'Download Complete');
      const body = t('click_to_open', '📁 Click to open file');
      const n = new Notification(title, {
        body: body,
        icon: '/favicon.ico',
        tag: `mixdm-done-${task.id}`
      });
      n.onclick = () => {
        window.focus();
        openFolder(task.outputPath || '');
        n.close();
      };
    }
  }
}

// ── URL Analysis ────────────────────────────────────────────
async function analyzeUrl() {
  const url = $('url-input').value.trim();
  if (!url) return;

  const badge = $('file-info-badge');
  const btn = $('btn-analyze');
  btn.disabled = true;
  btn.textContent = t('btn_analyzing', '⏳ Analyzing...');
  badge.className = 'info-badge';
  $('btn-download').disabled = true;
  analyzedInfo = null;
  $('video-preview').classList.remove('show');

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Analysis failed');

    analyzedInfo = data;

    if (data.isYtdlp) {
      setYtMode(true);
      if (data.cookieWarning) {
        badge.className = 'info-badge show warn';
        badge.textContent = t('warn_cookies_locked', `⚠ Cookies Locked: Guest quality loaded (540p). Close Chrome & retry for high quality.`);
        toast(data.cookieWarning, 'info');
      } else {
        badge.className = 'info-badge show yt';
        const sizeStr = data.fileSize > 0 ? ` · ${fmtBytes(data.fileSize)}` : '';
        badge.textContent = `✓ ${data.platform || 'Video'} · ${fmtDuration(data.duration) || t('ready_to_download', 'Ready to download')}${sizeStr}`;
      }
      showVideoPreview(data);
    } else {
      setYtMode(false);
      badge.className = 'info-badge show ' + (data.supportsRange ? 'success' : 'warn');
      badge.textContent = data.supportsRange
        ? `✓ ${fmtBytes(data.fileSize)} · ${t('segmented_ok', 'Segmented OK')}`
        : `⚠ ${fmtBytes(data.fileSize) || t('size_unknown', 'Unknown size')} · ${t('single_thread', 'Single thread')}`;
    }
    $('btn-download').disabled = false;
  } catch (err) {
    badge.className = 'info-badge show warn';
    badge.textContent = `✗ ${err.message}`;
    $('btn-download').disabled = false;
  } finally {
    btn.disabled = false;
    btn.textContent = t('btn_analyze', '🔍 Analyze');
  }
}

// ── Start Download ──────────────────────────────────────────
async function startDownload() {
  const url = $('url-input').value.trim();
  if (!url) { toast(t('toast_enter_url', 'Please enter a URL'), 'error'); return; }

  let success = false;
  if (isYtMode) {
    success = await startYtDownload(url);
  } else {
    success = await startHttpDownload(url);
  }

  if (success && appSettings.clearAfterStart) {
    $('url-input').value = '';
    $('btn-download').disabled = true;
    $('file-info-badge').className = 'info-badge';
    $('video-preview').classList.remove('show');
    analyzedInfo = null;
    setYtMode(false);
  }
}

async function startYtDownload(url, bypassSafety = false) {
  const format = $('format-select').value;
  const title = analyzedInfo?.title || '';
  const thumbnail = analyzedInfo?.thumbnail || '';
  
  // Find selected format size
  const fmtObj = analyzedInfo?.formats?.find(f => f.value === format);
  const fileSize = fmtObj ? fmtObj.size : 0;

  // Speed limit from settings
  const speedLimitKbps = (appSettings.speedLimitEnabled && appSettings.speedLimitKbps > 0)
    ? appSettings.speedLimitKbps : 0;
  const speedMode = appSettings.speedMode || 'full';

  try {
    const res = await fetch('/api/yt-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, format, title, thumbnail, fileSize, speedLimitKbps, speedMode, bypassSafety })
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.safetyWarning) {
        const confirmed = await showSafetyWarning(data.error);
        if (confirmed) {
          return await startYtDownload(url, true);
        }
        return false;
      }
      throw new Error(data.error || 'Failed to start download');
    }

    tasks.set(data.id, data);
    renderTask(data);
    filterTasks();
    if (data.speedPolicy?.quota) {
      quotaStatus = data.speedPolicy.quota;
      renderQuotaStatus();
    } else {
      refreshQuotaStatus();
    }
    const effectiveLimit = data.speedLimitKbps || data.speedPolicy?.effectiveSpeedLimitKbps || 0;
    const quotaStr = data.speedPolicy?.quotaWasExhausted ? ' (quota exhausted)' : data.speedPolicy?.quotaConsumed ? ' (high-speed quota used)' : '';
    const modeStr = data.speedPolicy?.speedMode?.label ? ` [${data.speedPolicy.speedMode.label}]` : '';
    const limitStr = effectiveLimit > 0 ? ` (limited to ${formatKbps(effectiveLimit)})${quotaStr}${modeStr}` : quotaStr + modeStr;
    const queueStr = data.status === 'queued' && data.queuePosition ? ` (queued #${data.queuePosition})` : '';
    toast(t('toast_yt_download_started', 'Video download started!') + limitStr + queueStr, 'success');
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

async function startHttpDownload(url, bypassSafety = false) {
  // Use settings: defaultSegments, speedLimitKbps
  const segments = appSettings.defaultSegments || parseInt($('seg-count').value, 10) || 8;
  const filename = analyzedInfo?.filename;
  const speedLimitKbps = (appSettings.speedLimitEnabled && appSettings.speedLimitKbps > 0)
    ? appSettings.speedLimitKbps : 0;
  const speedMode = appSettings.speedMode || 'full';

  // Advanced Headers
  const headers = {};
  const ua = $('adv-user-agent').value.trim();
  const ref = $('adv-referer').value.trim();
  const cookies = $('adv-cookies').value.trim();

  if (ua) headers['User-Agent'] = ua;
  if (ref) headers['Referer'] = ref;
  if (cookies) headers['Cookie'] = cookies;

  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        filename,
        segments,
        speedLimitKbps,
        speedMode,
        bypassSafety,
        headers: Object.keys(headers).length > 0 ? headers : undefined
      })
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.safetyWarning) {
        const confirmed = await showSafetyWarning(data.error);
        if (confirmed) {
          return await startHttpDownload(url, true);
        }
        return false;
      }
      throw new Error(data.error || 'Failed to start download');
    }

    tasks.set(data.id, data);
    renderTask(data);
    filterTasks();
    if (data.speedPolicy?.quota) {
      quotaStatus = data.speedPolicy.quota;
      renderQuotaStatus();
    } else {
      refreshQuotaStatus();
    }
    const effectiveLimit = data.speedLimitKbps || data.speedPolicy?.effectiveSpeedLimitKbps || 0;
    const quotaStr = data.speedPolicy?.quotaWasExhausted ? ' (quota exhausted)' : data.speedPolicy?.quotaConsumed ? ' (high-speed quota used)' : '';
    const modeStr = data.speedPolicy?.speedMode?.label ? ` [${data.speedPolicy.speedMode.label}]` : '';
    const limitStr = effectiveLimit > 0 ? ` (limited to ${formatKbps(effectiveLimit)})${quotaStr}${modeStr}` : quotaStr + modeStr;
    const queueStr = data.status === 'queued' && data.queuePosition ? ` (queued #${data.queuePosition})` : '';
    toast(t('toast_download_started', 'Download started!') + ` ${segments} threads` + limitStr + queueStr, 'success');

    // Clear advanced inputs if successful
    if (appSettings.clearAfterStart) {
      $('adv-user-agent').value = '';
      $('adv-referer').value = '';
      $('adv-cookies').value = '';
      $('advanced-fields').style.display = 'none';
    }

    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

async function pauseTask(id) {
  const task = tasks.get(id);
  if (task) {
    task.pendingAction = 'pause';
    renderTask(task);
  }
  try {
    const res = await fetch(`/api/tasks/${id}/pause`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to pause download');
    if (data.task) {
      tasks.set(data.task.id, data.task);
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (task) delete task.pendingAction;
    const current = tasks.get(id);
    if (current) {
      delete current.pendingAction;
      renderTask(current);
    }
    filterTasks();
  }
}

async function resumeTask(id) {
  const task = tasks.get(id);
  if (task) {
    task.pendingAction = 'resume';
    renderTask(task);
  }
  try {
    const res = await fetch(`/api/tasks/${id}/resume`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to resume download');
    if (data.task) {
      tasks.set(data.task.id, data.task);
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (task) delete task.pendingAction;
    const current = tasks.get(id);
    if (current) {
      delete current.pendingAction;
      renderTask(current);
    }
    filterTasks();
  }
}

async function pauseYtTask(id) {
  const task = tasks.get(id);
  if (task) {
    task.pendingAction = 'pause';
    renderTask(task);
  }
  try {
    const res = await fetch(`/api/yt-tasks/${id}/pause`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to pause download');
    if (data.task) {
      tasks.set(data.task.id, data.task);
    }
    toast('YouTube download stopped', 'info');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (task) delete task.pendingAction;
    const current = tasks.get(id);
    if (current) {
      delete current.pendingAction;
      renderTask(current);
    }
    filterTasks();
  }
}

async function resumeYtTask(id) {
  const task = tasks.get(id);
  if (task) {
    task.pendingAction = 'resume';
    renderTask(task);
  }
  try {
    const res = await fetch(`/api/yt-tasks/${id}/resume`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to resume download');
    if (data.task) {
      tasks.set(data.task.id, data.task);
    }
    toast('Resuming YouTube download...', 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (task) delete task.pendingAction;
    const current = tasks.get(id);
    if (current) {
      delete current.pendingAction;
      renderTask(current);
    }
    filterTasks();
  }
}

async function retryWithCookies(event, id) {
  if (event) event.preventDefault();
  const task = tasks.get(id);
  if (!task) return;

  const browser = appSettings.cookiesBrowser || 'chrome';
  
  task.pendingAction = 'resume';
  task.errorMessage = '';
  renderTask(task);

  try {
    const res = await fetch(`/api/yt-tasks/${id}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookiesBrowser: browser })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to retry download');
    if (data.task) {
      tasks.set(data.task.id, data.task);
    }
    toast(`Retrying with ${browser.toUpperCase()} cookies...`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (task) delete task.pendingAction;
    const current = tasks.get(id);
    if (current) {
      delete current.pendingAction;
      renderTask(current);
    }
    filterTasks();
  }
}

async function openFolder(filePath) {
  await fetch('/api/open-folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filePath: filePath || '' })
  });
}

async function removeTask(id, isYt) {
  const task = tasks.get(id);
  if (task) {
    task.pendingAction = 'remove';
    renderTask(task);
  }
  try {
    const endpoint = isYt ? `/api/yt-tasks/${id}` : `/api/tasks/${id}`;
    const res = await fetch(endpoint, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to remove task');
    }
    tasks.delete(id);
    const card = document.getElementById(`task-${id}`);
    if (card) card.remove();
  } catch (err) {
    toast(err.message, 'error');
    if (task) delete task.pendingAction;
    const current = tasks.get(id);
    if (current) {
      delete current.pendingAction;
      renderTask(current);
    }
  } finally {
    filterTasks();
  }
}
