(function () {
  const BUTTON_ID = 'mixdm-floating-download';
  const MENU_ID = 'mixdm-download-menu';
  const HANDLE_ID = 'mixdm-floating-handle';
  const POSITION_KEY = 'mixdm-button-position';
  const QUICK_FORMATS = [
    { label: 'Best Quality', value: 'bestvideo+bestaudio[ext=m4a]/bestvideo+bestaudio/best', isBest: true },
    { label: '1080p (Full HD)', value: 'bestvideo[height<=1080]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]', height: 1080 },
    { label: '720p (HD)', value: 'bestvideo[height<=720]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]', height: 720 },
    { label: '480p', value: 'bestvideo[height<=480]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]', height: 480 },
    { label: '360p', value: 'bestvideo[height<=360]+bestaudio[ext=m4a]/bestvideo[height<=360]+bestaudio/best[height<=360]', height: 360 },
    { label: 'Audio Only - Best Original', value: 'mixdm:audio:original', audioOnly: true },
    { label: 'MP3 320 kbps', value: 'mixdm:audio:mp3:320', audioOnly: true },
    { label: 'MP3 256 kbps', value: 'mixdm:audio:mp3:256', audioOnly: true },
    { label: 'MP3 192 kbps', value: 'mixdm:audio:mp3:192', audioOnly: true }
  ];
  let lastUrl = '';
  let currentInfo = null;
  let isAnalyzing = false;
  let analyzePromise = null;
  let analyzeUrl = '';
  let prefetchTimer = null;
  let dragState = null;
  let suppressNextClick = false;
  let tickInterval = null;
  let isManuallyHidden = false;
  let hasDetectedMedia = false;
  let activeTheme = 'default';

  function updateTheme() {
    sendMessage({ type: 'MIXDM_GET_THEME' }).then(res => {
      if (res && res.ok && res.theme) {
        activeTheme = res.theme;
        applyThemeClasses();
      }
    }).catch(() => {});
  }

  function applyThemeClasses() {
    const isShushutan = activeTheme === 'shushutan';
    const els = [
      document.getElementById(BUTTON_ID),
      document.getElementById(HANDLE_ID),
      document.getElementById(MENU_ID)
    ];
    els.forEach(el => {
      if (el) {
        if (isShushutan) el.classList.add('mixdm-theme-shushutan');
        else el.classList.remove('mixdm-theme-shushutan');
      }
    });
  }

  function isYoutubePage(url) {
    return /(?:youtube\.com\/(?:watch|shorts|live|embed|v|clip)|youtu\.be\/)/i.test(url);
  }

  // Social video platforms that yt-dlp can handle
  const SOCIAL_VIDEO_PATTERNS = [
    { pattern: /(?:youtube\.com\/(?:watch|shorts|live|embed|v|clip)|youtu\.be\/)/i,  label: 'YouTube',     icon: '▶️' },
    { pattern: /(?:twitter\.com|x\.com)\/\w+\/status\//i,                     label: 'X / Twitter', icon: '🐦' },
    { pattern: /(?:www\.)?facebook\.com\/(?:watch|video|reel|share\/v|\w+\/videos?)/i, label: 'Facebook', icon: '👤' },
    { pattern: /(?:fb\.watch|fb\.me)\//i,                                       label: 'Facebook', icon: '👤' },
    { pattern: /instagram\.com\/(?:p|reel|tv)\//i,                             label: 'Instagram',   icon: '📸' },
    { pattern: /(?:www\.)?tiktok\.com\/@[\w.]+\/video\//i,                    label: 'TikTok',      icon: '🎵' },
    { pattern: /vm\.tiktok\.com\//i,                                            label: 'TikTok',      icon: '🎵' },
    { pattern: /reddit\.com\/r\/\w+\/comments\//i,                             label: 'Reddit',      icon: '🤖' },
    { pattern: /twitch\.tv\/(?:videos?\/|clips?\/|\w+\/clip\/)/i,             label: 'Twitch',      icon: '🎮' },
    { pattern: /vimeo\.com\/\d+/i,                                              label: 'Vimeo',       icon: '🎬' },
    { pattern: /dailymotion\.com\/video\//i,                                    label: 'Dailymotion', icon: '📺' },
  ];

  function detectSocialPlatform(url) {
    return SOCIAL_VIDEO_PATTERNS.find(p => p.pattern.test(url)) || null;
  }

  function isSupportedPage(url) {
    return SOCIAL_VIDEO_PATTERNS.some(p => p.pattern.test(url));
  }

  function detectPlatformLabel(url) {
    const p = detectSocialPlatform(url);
    return p ? `${p.icon} Download · ${p.label}` : '⬇️ Download with MIXDM';
  }

  function pageTitle() {
    const ogTitle = document.querySelector('meta[property="og:title"]')?.content;
    return (ogTitle || document.title || '').replace(/\s+-\s+YouTube$/i, '').trim();
  }

  function pageThumbnail() {
    return document.querySelector('meta[property="og:image"]')?.content ||
      document.querySelector('meta[name="twitter:image"]')?.content ||
      document.querySelector('link[rel="image_src"]')?.href ||
      '';
  }

  function isContextValid() {
    try {
      return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function sendMessage(message) {
    if (!isContextValid()) {
      return Promise.resolve({ ok: false, error: 'Extension context invalidated. Please refresh the page.' });
    }
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(message, response => {
          if (chrome.runtime.lastError) {
            console.error('MIXDM Extension Error:', chrome.runtime.lastError.message);
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(response);
          }
        });
      } catch (err) {
        console.error('MIXDM Extension Error:', err.message);
        resolve({ ok: false, error: err.message });
      }
    });
  }

  function payload(extra = {}) {
    return {
      url: location.href,
      title: pageTitle(),
      thumbnail: pageThumbnail(),
      source: 'page-menu',
      referer: location.href,
      tabUrl: location.href,
      ...extra
    };
  }

  function setButtonState(button, text, disabled = false) {
    button.textContent = text;
    button.disabled = disabled;
  }

  async function sendDownload(button, format) {
    setButtonState(button, '...', true);
    const response = await sendMessage({
      type: 'MIXDM_DOWNLOAD',
      payload: payload({ format })
    });

    if (response?.ok) {
      setButtonState(button, 'Sent', true);
    } else {
      setButtonState(button, 'MIXDM!', false);
      button.title = response?.error || chrome.runtime.lastError?.message || 'Could not send to MIXDM';
    }

    hideMenu();
    setTimeout(() => {
      setButtonState(button, 'MIXDM', false);
      button.title = 'Download with MIXDM';
    }, 1600);
  }

  async function openOptions(button) {
    setButtonState(button, '...', true);
    await sendMessage({ type: 'MIXDM_OPEN_ANALYZE', payload: payload() });
    hideMenu();
    setTimeout(() => setButtonState(button, 'MIXDM', false), 800);
  }

  function hideMenu() {
    document.getElementById(MENU_ID)?.remove();
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
  }

  function defaultPosition(button) {
    const rect = button.getBoundingClientRect();
    return {
      left: window.innerWidth - rect.width - 18,
      top: window.innerHeight - rect.height - 88
    };
  }

  function loadButtonPosition(button) {
    const saved = localStorage.getItem(POSITION_KEY);
    if (saved) {
      try {
        const pos = JSON.parse(saved);
        if (Number.isFinite(pos.left) && Number.isFinite(pos.top)) return pos;
      } catch (_) {}
    }
    return defaultPosition(button);
  }

  function applyButtonPosition(button, pos) {
    const rect = button.getBoundingClientRect();
    const margin = 8;
    const left = clamp(pos.left, margin, window.innerWidth - rect.width - margin);
    const top = clamp(pos.top, margin, window.innerHeight - rect.height - margin);
    button.style.left = `${left}px`;
    button.style.top = `${top}px`;
    return { left, top };
  }

  function saveButtonPosition(button) {
    const rect = button.getBoundingClientRect();
    localStorage.setItem(POSITION_KEY, JSON.stringify({
      left: Math.round(rect.left),
      top: Math.round(rect.top)
    }));
  }

  function positionMenu(button) {
    const menu = document.getElementById(MENU_ID);
    if (!menu) return;

    const buttonRect = button.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const margin = 8;
    let left = buttonRect.left;
    let top = buttonRect.top - menuRect.height - 8;

    if (top < margin) top = buttonRect.bottom + 8;
    left = clamp(left, margin, window.innerWidth - menuRect.width - margin);
    top = clamp(top, margin, window.innerHeight - menuRect.height - margin);

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function labelSize(format) {
    // Check all possible size fields: format.size (MIXDM server), format.filesize, format.fileSize (yt-dlp raw)
    const bytes = format.size || format.filesize || format.fileSize || 0;
    if (!bytes || bytes <= 0) return '';
    if (bytes >= 1073741824) return `~${(bytes / 1073741824).toFixed(1)} GB`;
    if (bytes >= 1048576)    return `~${(bytes / 1048576).toFixed(0)} MB`;
    if (bytes >= 1024)       return `~${Math.round(bytes / 1024).toLocaleString()} KB`;
    return `${bytes} B`;
  }

  function preferredAudio(formats) {
    return formats.find(f => f.value === 'mixdm:audio:original') ||
      formats.find(f => f.audioOnly) ||
      null;
  }

  function preferredVideo(formats) {
    return formats.find(f => f.isBest) ||
      formats.find(f => !f.audioOnly && /best/i.test(f.label || '')) ||
      formats.find(f => !f.audioOnly) ||
      null;
  }

  function videoFormatsByQuality(formats) {
    const best = preferredVideo(formats);
    const heights = [...new Set(formats
      .filter(f => !f.audioOnly && f.height)
      .map(f => f.height))]
      .sort((a, b) => b - a);

    const result = [];
    if (best) result.push(best);
    heights.forEach(height => {
      const format = formats.find(f => !f.audioOnly && f.height === height);
      if (format && format !== best) result.push(format);
    });

    formats.forEach(format => {
      if (!format.audioOnly && !result.includes(format)) result.push(format);
    });

    return result;
  }

  function preferredMp3Formats(formats) {
    const bitrates = ['320', '256', '192'];
    return bitrates
      .map(rate => formats.find(f => f.value === `mixdm:audio:mp3:${rate}`))
      .filter(Boolean);
  }

  function compactFormats(formats) {
    const audio = preferredAudio(formats);
    const videoFormats = videoFormatsByQuality(formats);
    const mp3Formats = preferredMp3Formats(formats);
    const result = [];

    videoFormats.forEach(format => {
      result.push({ kind: 'format', label: format.label, format });
    });
    if (audio) result.push({ kind: 'format', label: audio.label, format: audio });
    mp3Formats.forEach(format => {
      if (format !== audio) result.push({ kind: 'format', label: format.label, format });
    });

    for (const format of formats) {
      if (format === audio || videoFormats.includes(format) || mp3Formats.includes(format)) continue;
      result.push({ kind: 'format', label: format.label, format });
    }

    return result;
  }

  function menuLabel(item, index) {
    const format = item.format || {};
    // Only append size if the label doesn't already contain a size (server-built labels include it)
    const labelHasSize = /\(~?\d+(\.\d+)?\s*(B|KB|MB|GB)\)/i.test(item.label || '');
    const size = labelHasSize ? '' : labelSize(format);
    const text = `${item.label}${size ? ` (${size})` : ''}`;
    if (format.isBest || format.audioOnly || /^MP3/i.test(item.label || '')) {
      return text;
    }
    return `${index + 1}. ${text}`;
  }

  function getMenuIcon(item) {
    const format = item.format || {};
    if (format.isBest) return '⚡';
    if (format.audioOnly) {
      if (format.value === 'mixdm:audio:original') return '🎵';
      return '💿';
    }
    return '🎬';
  }

  function createMenu(button, formats) {
    hideMenu();

    const menu = document.createElement('div');
    menu.id = MENU_ID;

    const header = document.createElement('div');
    header.className = 'mixdm-menu-header';
    header.textContent = detectPlatformLabel(location.href);
    menu.appendChild(header);

    const items = compactFormats(formats && formats.length ? formats : QUICK_FORMATS);
    items.forEach((item, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = item.format?.isBest ? 'mixdm-menu-primary' : '';
      
      const icon = getMenuIcon(item);
      const text = menuLabel(item, index);
      row.innerHTML = `<span class="mixdm-menu-icon">${icon}</span><span class="mixdm-menu-text">${text}</span>`;
      
      row.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        sendDownload(button, item.format.value);
      });
      menu.appendChild(row);
    });

    const options = document.createElement('button');
    options.type = 'button';
    options.innerHTML = `<span class="mixdm-menu-icon">🌐</span><span class="mixdm-menu-text">Open MIXDM App</span>`;
    options.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      openOptions(button);
    });
    menu.appendChild(options);

    const hideBtn = document.createElement('button');
    hideBtn.type = 'button';
    hideBtn.innerHTML = `<span class="mixdm-menu-icon">❌</span><span class="mixdm-menu-text">Hide Button</span>`;
    hideBtn.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      hideMenu();
      hideFloatingButtonPermanently();
    });
    menu.appendChild(hideBtn);

    document.documentElement.appendChild(menu);
    positionMenu(button);
    applyThemeClasses();
  }

  function analyzeFormats() {
    if (!isSupportedPage(location.href)) return Promise.resolve(null);
    if (currentInfo?.formats?.length) return Promise.resolve(currentInfo);
    if (isAnalyzing && analyzePromise && analyzeUrl === location.href) return analyzePromise;

    isAnalyzing = true;
    analyzeUrl = location.href;
    analyzePromise = sendMessage({ type: 'MIXDM_ANALYZE', payload: payload() })
      .then(response => {
        isAnalyzing = false;
        if (response?.ok && analyzeUrl === location.href) {
          currentInfo = response.info;
          return currentInfo;
        }
        if (!response?.ok) throw new Error(response?.error || 'Could not analyze this page');
        return null;
      })
      .catch(err => {
        isAnalyzing = false;
        throw err;
      });

    return analyzePromise;
  }

  function prefetchFormats() {
    // Only prefetch on YouTube (other platforms analyze too slowly to prefetch)
    if (!isYoutubePage(location.href)) return;
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(() => {
      analyzeFormats().catch(() => {});
    }, 900);
  }

  function showFastMenu(button) {
    const urlAtClick = location.href;
    createMenu(button, currentInfo?.formats || QUICK_FORMATS);

    analyzeFormats()
      .then(info => {
        if (!info?.formats?.length || location.href !== urlAtClick) return;
        if (document.getElementById(MENU_ID)) {
          createMenu(button, info.formats);
        }
      })
      .catch(err => {
        button.title = err.message;
      });
  }

  function showGrabbedStreamsMenu(button) {
    sendMessage({ type: 'MIXDM_GET_COUNT' }).then(res => {
      if (res && res.ok && res.count > 0) {
        sendMessage({ type: 'MIXDM_GET_DETECTED_MEDIA_TAB' }).then(mediaRes => {
          if (mediaRes && mediaRes.ok && mediaRes.media && mediaRes.media.length > 0) {
            createGrabberMenu(button, mediaRes.media);
          }
        });
      }
    });
  }

  function createGrabberMenu(button, mediaList) {
    hideMenu();

    const menu = document.createElement('div');
    menu.id = MENU_ID;

    const header = document.createElement('div');
    header.className = 'mixdm-menu-header';
    header.textContent = `📥 Captured Media (${mediaList.length})`;
    menu.appendChild(header);

    mediaList.forEach((item, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      
      let icon = '🎬';
      if (item.ext === 'mp3' || item.ext === 'm4a' || item.ext === 'wav' || item.ext === 'aac') {
        icon = '🎵';
      } else if (item.ext === 'm3u8' || item.ext === 'mpd') {
        icon = '📡';
      }
      
      let displayName = item.filename;
      if (displayName.length > 35) {
        displayName = displayName.substring(0, 18) + '...' + displayName.substring(displayName.length - 14);
      }
      
      row.innerHTML = `<span class="mixdm-menu-icon">${icon}</span><span class="mixdm-menu-text">${displayName}</span>`;
      
      row.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        hideMenu();
        sendMessage({
          type: 'MIXDM_DOWNLOAD',
          payload: {
            url: item.url,
            title: item.filename.replace(/\.[^/.]+$/, ""),
            filename: item.filename,
            source: 'inpage-grabber',
            referer: location.href,
            tabUrl: location.href
          }
        });
      });
      menu.appendChild(row);
    });

    const options = document.createElement('button');
    options.type = 'button';
    options.innerHTML = `<span class="mixdm-menu-icon">🌐</span><span class="mixdm-menu-text">Open MIXDM App</span>`;
    options.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      openOptions(button);
    });
    menu.appendChild(options);

    const hideBtn = document.createElement('button');
    hideBtn.type = 'button';
    hideBtn.innerHTML = `<span class="mixdm-menu-icon">❌</span><span class="mixdm-menu-text">Hide Button</span>`;
    hideBtn.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      hideMenu();
      hideFloatingButtonPermanently();
    });
    menu.appendChild(hideBtn);

    document.documentElement.appendChild(menu);
    positionMenu(button);
    applyThemeClasses();
  }

  function handleButtonClick(button, event) {
    event.preventDefault();
    event.stopPropagation();

    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }

    if (document.getElementById(MENU_ID)) {
      hideMenu();
      return;
    }

    if (isSupportedPage(location.href)) {
      showFastMenu(button);
    } else {
      showGrabbedStreamsMenu(button);
    }
  }

  function startDrag(button, event) {
    if (event.button !== 0) return;
    const rect = button.getBoundingClientRect();
    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      moved: false
    };
    button.setPointerCapture(event.pointerId);
    button.classList.add('mixdm-dragging');
    hideMenu();
  }

  function moveDrag(button, event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) dragState.moved = true;
    applyButtonPosition(button, {
      left: dragState.left + dx,
      top: dragState.top + dy
    });
  }

  function endDrag(button, event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    button.releasePointerCapture(event.pointerId);
    button.classList.remove('mixdm-dragging');
    if (dragState.moved) {
      suppressNextClick = true;
      saveButtonPosition(button);
    }
    dragState = null;
  }

  function ensureStyle() {
    if (document.getElementById('mixdm-content-style')) return;

    const style = document.createElement('style');
    style.id = 'mixdm-content-style';
    style.textContent = `
      #${HANDLE_ID}, #${BUTTON_ID}, #${MENU_ID} {
        --mixdm-bg-base: #0f1015;
        --mixdm-bg-hover: #17181d;
        --mixdm-accent: #6366f1;
        --mixdm-accent-glow: rgba(99, 102, 241, 0.2);
        --mixdm-badge-bg: #8b5cf6;
        --mixdm-menu-bg: #0c0e14;
        --mixdm-text: #a0a5b4;
        --mixdm-menu-hover-bg: linear-gradient(90deg, rgba(99, 102, 241, 0.15) 0%, rgba(99, 102, 241, 0.03) 100%);
        --mixdm-menu-primary-bg: linear-gradient(90deg, rgba(99, 102, 241, 0.1) 0%, rgba(99, 102, 241, 0.01) 100%);
        --mixdm-border-glow: rgba(255, 255, 255, 0.05);
      }

      #${HANDLE_ID}.mixdm-theme-shushutan, #${BUTTON_ID}.mixdm-theme-shushutan, #${MENU_ID}.mixdm-theme-shushutan {
        --mixdm-bg-base: #121924;
        --mixdm-bg-hover: #18212f;
        --mixdm-accent: #3acce6;
        --mixdm-accent-glow: rgba(58, 204, 230, 0.25);
        --mixdm-badge-bg: #ff6992;
        --mixdm-menu-bg: #121924;
        --mixdm-text: #a0b2c6;
        --mixdm-menu-hover-bg: linear-gradient(90deg, rgba(255, 105, 146, 0.15) 0%, rgba(255, 105, 146, 0.03) 100%);
        --mixdm-menu-primary-bg: linear-gradient(90deg, rgba(58, 204, 230, 0.12) 0%, rgba(58, 204, 230, 0.01) 100%);
        --mixdm-border-glow: rgba(58, 204, 230, 0.15);
      }

      #${HANDLE_ID} {
        position: fixed;
        right: 0;
        z-index: 2147483647;
        width: 14px;
        height: 38px;
        border: 1px solid rgba(255,255,255,0.12);
        border-right: 0;
        border-radius: 8px 0 0 8px;
        background: var(--mixdm-bg-base);
        color: var(--mixdm-accent);
        box-shadow: -2px 4px 12px rgba(0,0,0,0.5);
        font: 11px/38px sans-serif;
        text-align: center;
        cursor: pointer;
        opacity: 0.4;
        transition: all 0.2s ease;
        user-select: none;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      #${HANDLE_ID}:hover {
        opacity: 1;
        width: 24px;
        color: var(--mixdm-accent);
        border-color: var(--mixdm-accent);
      }
      
      :fullscreen #${BUTTON_ID}, :fullscreen #${HANDLE_ID}, :fullscreen #${MENU_ID} {
        display: none !important;
      }
      :-webkit-full-screen #${BUTTON_ID}, :-webkit-full-screen #${HANDLE_ID}, :-webkit-full-screen #${MENU_ID} {
        display: none !important;
      }
      :-moz-full-screen #${BUTTON_ID}, :-moz-full-screen #${HANDLE_ID}, :-moz-full-screen #${MENU_ID} {
        display: none !important;
      }
      :-ms-fullscreen #${BUTTON_ID}, :-ms-fullscreen #${HANDLE_ID}, :-ms-fullscreen #${MENU_ID} {
        display: none !important;
      }
 
      #${BUTTON_ID} {
        position: fixed;
        left: calc(100vw - 92px);
        top: calc(100vh - 126px);
        z-index: 2147483647;
        min-width: 82px;
        height: 38px;
        padding: 0 14px;
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 10px;
        background: var(--mixdm-bg-base);
        color: var(--mixdm-accent);
        box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        font: 700 13px/1.1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        letter-spacing: 0.5px;
        cursor: grab;
        touch-action: none;
        user-select: none;
        transition: all 0.2s ease;
      }
      #${BUTTON_ID}:hover {
        background: var(--mixdm-bg-hover);
        border-color: var(--mixdm-accent);
        box-shadow: 0 8px 24px var(--mixdm-accent-glow);
      }
      #${BUTTON_ID}.mixdm-dragging {
        cursor: grabbing;
        opacity: 0.92;
      }
      #${BUTTON_ID}:disabled { cursor: wait; opacity: 0.78; }
      
      #${BUTTON_ID} .mixdm-badge {
        position: absolute;
        top: -6px;
        right: -6px;
        background: var(--mixdm-badge-bg);
        color: #fff;
        font-size: 10px;
        font-weight: 700;
        border-radius: 50%;
        min-width: 18px;
        height: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0 4px;
        border: 2px solid var(--mixdm-bg-base);
        box-shadow: 0 2px 6px rgba(0,0,0,0.5);
      }
      
      #${MENU_ID} {
        position: fixed;
        left: 18px;
        top: 18px;
        z-index: 2147483647;
        width: 320px;
        max-height: 360px;
        overflow-y: auto;
        overflow-x: hidden;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 16px;
        background: var(--mixdm-menu-bg);
        box-shadow: 0 20px 48px rgba(0,0,0,0.6), 0 0 0 1px var(--mixdm-border-glow);
        padding: 10px;
        font: 500 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        box-sizing: border-box;
      }
      
      /* Scrollbar */
      #${MENU_ID}::-webkit-scrollbar {
        width: 6px;
      }
      #${MENU_ID}::-webkit-scrollbar-track {
        background: transparent;
      }
      #${MENU_ID}::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.12);
        border-radius: 3px;
      }
      #${MENU_ID}::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.24);
      }
 
      #${MENU_ID} .mixdm-menu-header {
        padding: 8px 12px 12px 12px;
        color: var(--mixdm-accent);
        font-weight: 700;
        font-size: 14px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
        margin-bottom: 8px;
        letter-spacing: 0.5px;
        text-transform: none;
      }
      
      #${MENU_ID} button {
        display: flex;
        align-items: center;
        width: 100%;
        min-height: 38px;
        padding: 8px 12px 8px 9px;
        margin-bottom: 4px;
        border: 0;
        border-left: 3px solid transparent;
        border-radius: 0 10px 10px 0;
        background: transparent;
        color: var(--mixdm-text);
        text-align: left;
        cursor: pointer;
        font: inherit;
        box-sizing: border-box;
        transition: all 0.15s ease;
        gap: 10px;
      }
      
      #${MENU_ID} button:hover {
        background: var(--mixdm-menu-hover-bg) !important;
        border-left-color: var(--mixdm-accent) !important;
        color: var(--mixdm-accent) !important;
        font-weight: 600;
      }
      
      #${MENU_ID} button.mixdm-menu-primary {
        background: var(--mixdm-menu-primary-bg);
        border-left-color: var(--mixdm-accent);
        color: var(--mixdm-accent);
        font-weight: 600;
      }
      
      #${MENU_ID}:hover button.mixdm-menu-primary:not(:hover) {
        background: rgba(255, 255, 255, 0.05);
        border-left-color: transparent;
        color: #ffffff;
        font-weight: 500;
      }
      
      .mixdm-menu-icon {
        font-size: 15px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        width: 20px;
      }
      .mixdm-menu-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function updateButtonBadge(count) {
    const button = document.getElementById(BUTTON_ID);
    if (!button) return;
    
    let badge = button.querySelector('.mixdm-badge');
    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'mixdm-badge';
        button.appendChild(badge);
      }
      badge.textContent = count;
    } else {
      if (badge) badge.remove();
    }
  }

  function hideFloatingButtonPermanently() {
    isManuallyHidden = true;
    const button = document.getElementById(BUTTON_ID);
    if (button) button.style.display = 'none';
    hideMenu();
    createEdgeHandle();
  }

  function showFloatingButton() {
    isManuallyHidden = false;
    const button = document.getElementById(BUTTON_ID);
    if (button) {
      button.style.display = '';
    }
    ensureButton();
    removeEdgeHandle();
  }

  function createEdgeHandle() {
    removeEdgeHandle();
    const handle = document.createElement('div');
    handle.id = HANDLE_ID;
    
    const button = document.getElementById(BUTTON_ID);
    let topPos = '50%';
    if (button) {
      topPos = button.style.top || `${button.getBoundingClientRect().top}px`;
    }
    
    handle.style.top = topPos;
    handle.title = 'Show MIXDM Button';
    handle.innerHTML = '◀';
    
    handle.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      showFloatingButton();
    });
    
    document.documentElement.appendChild(handle);
    applyThemeClasses();
  }

  function removeEdgeHandle() {
    document.getElementById(HANDLE_ID)?.remove();
  }

  function ensureButton() {
    ensureStyle();
    const existing = document.getElementById(BUTTON_ID);
    if (window !== window.top) {
      if (existing) existing.remove();
      hideMenu();
      return;
    }
    const shouldShow = (isSupportedPage(location.href) || hasDetectedMedia) && !isManuallyHidden;
    if (!shouldShow) {
      if (existing) existing.remove();
      hideMenu();
      return;
    }

    if (existing) return;

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = 'MIXDM';
    button.title = 'Download with MIXDM';
    button.addEventListener('pointerdown', event => startDrag(button, event));
    button.addEventListener('pointermove', event => moveDrag(button, event));
    button.addEventListener('pointerup', event => endDrag(button, event));
    button.addEventListener('pointercancel', event => endDrag(button, event));
    button.addEventListener('click', event => handleButtonClick(button, event));
    document.documentElement.appendChild(button);
    requestAnimationFrame(() => applyButtonPosition(button, loadButtonPosition(button)));
    applyThemeClasses();

    // Fetch initial captured streams count from background script
    sendMessage({ type: 'MIXDM_GET_COUNT' }).then(res => {
      if (res && res.ok && res.count !== undefined) {
        updateButtonBadge(res.count);
      }
    });
  }

  document.addEventListener('click', event => {
    const menu = document.getElementById(MENU_ID);
    const button = document.getElementById(BUTTON_ID);
    if (!menu) return;
    if (menu.contains(event.target) || button?.contains(event.target)) return;
    hideMenu();
  }, true);

  window.addEventListener('resize', () => {
    const button = document.getElementById(BUTTON_ID);
    if (!button) return;
    applyButtonPosition(button, {
      left: button.getBoundingClientRect().left,
      top: button.getBoundingClientRect().top
    });
    saveButtonPosition(button);
    positionMenu(button);
  });

  const reportedUrls = new Set();

  function reportMediaUrl(url) {
    if (!url || typeof url !== 'string') return;
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;
    if (/google-analytics|doubleclick|ads\b|\/adsystem\//i.test(url)) return;
    
    const isMedia = /\.(mp4|webm|mkv|flv|mov|avi|mp3|aac|wav|m4a|m3u8|mpd)(?:\?|$)/i.test(url);
    if (!isMedia) return;

    if (reportedUrls.has(url)) return;
    reportedUrls.add(url);

    sendMessage({
      type: 'MIXDM_REPORT_MEDIA',
      url: url,
      title: pageTitle()
    });
  }

  function scanAndReportMedia() {
    const elements = document.querySelectorAll('video, audio');
    elements.forEach(el => {
      if (el.src) reportMediaUrl(el.src);
      if (el.currentSrc) reportMediaUrl(el.currentSrc);

      const sources = el.querySelectorAll('source');
      sources.forEach(src => {
        if (src.src) reportMediaUrl(src.src);
      });

      if (!el.dataset.mixdmHooked) {
        el.dataset.mixdmHooked = 'true';
        const onMediaEvent = () => {
          if (el.src) reportMediaUrl(el.src);
          if (el.currentSrc) reportMediaUrl(el.currentSrc);
        };
        el.addEventListener('play', onMediaEvent);
        el.addEventListener('playing', onMediaEvent);
        el.addEventListener('loadedmetadata', onMediaEvent);
        el.addEventListener('loadstart', onMediaEvent);
      }
    });

    const standaloneSources = document.querySelectorAll('source');
    standaloneSources.forEach(src => {
      if (src.src) reportMediaUrl(src.src);
    });
  }

  let tickCount = 0;
  function tick() {
    if (!isContextValid()) {
      if (tickInterval) clearInterval(tickInterval);
      document.getElementById(BUTTON_ID)?.remove();
      document.getElementById(MENU_ID)?.remove();
      document.getElementById('mixdm-content-style')?.remove();
      return;
    }

    scanAndReportMedia();

    tickCount++;
    if (tickCount % 7 === 0) {
      updateTheme();
    }

    if (location.href !== lastUrl) {
      lastUrl = location.href;
      currentInfo = null;
      analyzePromise = null;
      analyzeUrl = '';
      isManuallyHidden = false;
      removeEdgeHandle();
      hideMenu();
      setTimeout(ensureButton, 400);
      prefetchFormats();
    }
  }

  if (isContextValid()) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type === 'MIXDM_UPDATE_COUNT') {
        hasDetectedMedia = message.count > 0;
        ensureButton();
        updateButtonBadge(message.count);
      } else if (message?.type === 'MIXDM_TOGGLE_BUTTON') {
        if (isManuallyHidden) {
          showFloatingButton();
        } else {
          hideFloatingButtonPermanently();
        }
        sendResponse({ ok: true, isHidden: isManuallyHidden });
      } else if (message?.type === 'MIXDM_GET_BUTTON_STATUS') {
        sendResponse({ ok: true, isHidden: isManuallyHidden });
      } else if (message?.type === 'MIXDM_GET_CLICKED_IMAGE') {
        let imgUrl = null;
        const target = document.elementFromPoint(lastRightClickX, lastRightClickY);
        if (target) {
          if (target.tagName === 'IMG') {
            imgUrl = target.src;
          } else {
            const origPE = target.style.pointerEvents;
            target.style.pointerEvents = 'none';
            const under = document.elementFromPoint(lastRightClickX, lastRightClickY);
            target.style.pointerEvents = origPE;
            if (under && under.tagName === 'IMG') {
              imgUrl = under.src;
            } else {
              const parent = target.parentElement;
              if (parent) {
                const img = parent.querySelector('img');
                if (img) imgUrl = img.src;
              }
            }
          }
        }
        sendResponse({ ok: true, url: imgUrl });
      }
    });
  }

  let lastRightClickX = 0;
  let lastRightClickY = 0;

  document.addEventListener('contextmenu', event => {
    lastRightClickX = event.clientX;
    lastRightClickY = event.clientY;
  }, true);

  ensureButton();
  prefetchFormats();
  updateTheme();
  tickInterval = setInterval(tick, 700);
})();
