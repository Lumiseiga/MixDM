const els = {
  status: document.getElementById('status'),
  tabTitle: document.getElementById('tab-title'),
  tabUrl: document.getElementById('tab-url'),
  download: document.getElementById('download'),
  openOptions: document.getElementById('open-options'),
  toggleFloating: document.getElementById('toggle-floating'),
  refresh: document.getElementById('refresh'),
  message: document.getElementById('message'),
  interceptToggle: document.getElementById('intercept-toggle'),
  interceptSub: document.getElementById('intercept-sub')
};

let activeTab = null;

function sendMessage(message) {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
    return Promise.resolve({ ok: false, error: 'Extension context invalidated.' });
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

function sendTabMessage(message) {
  if (!activeTab || activeTab.id === undefined) return Promise.resolve(null);
  return new Promise(resolve => {
    try {
      chrome.tabs.sendMessage(activeTab.id, message, response => {
        if (chrome.runtime.lastError) {
          resolve(null);
        } else {
          resolve(response);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

function updateToggleButtonUI(isHidden) {
  if (!els.toggleFloating) return;
  if (isHidden) {
    els.toggleFloating.textContent = 'Show Floating Button';
  } else {
    els.toggleFloating.textContent = 'Hide Floating Button';
  }
}

function queryActiveTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs[0] || null));
  });
}

function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function showMessage(text, type = '') {
  els.message.textContent = text;
  els.message.className = `message ${type}`;
}

function setBusy(on) {
  const canUse = isHttpUrl(activeTab?.url || '');
  els.download.disabled = on || !canUse;
  els.openOptions.disabled = on || !canUse;
  if (els.toggleFloating) els.toggleFloating.disabled = on || !canUse;
}

async function refreshStatus() {
  const response = await sendMessage({ type: 'MIXDM_STATUS' });
  if (response?.ok) {
    els.status.textContent = 'App connected';
    els.status.className = 'status online';
    return true;
  }

  els.status.textContent = 'App offline';
  els.status.className = 'status offline';
  return false;
}

function tabPayload() {
  return {
    url: activeTab?.url || '',
    title: activeTab?.title || '',
    source: 'popup',
    referer: activeTab?.url || '',
    tabUrl: activeTab?.url || ''
  };
}

function renderDetectedMedia(mediaList) {
  const container = document.getElementById('media-list');
  container.innerHTML = '';
  
  if (!mediaList || mediaList.length === 0) {
    container.innerHTML = '<div class="no-media">No media streams detected. Play a video or audio to capture.</div>';
    return;
  }
  
  mediaList.forEach(item => {
    const itemEl = document.createElement('div');
    itemEl.className = 'media-item';
    
    const infoEl = document.createElement('div');
    infoEl.className = 'media-info';
    
    const badgeEl = document.createElement('span');
    badgeEl.className = `media-badge ${item.ext}`;
    badgeEl.textContent = item.ext;
    
    const nameEl = document.createElement('span');
    nameEl.className = 'media-name';
    nameEl.textContent = item.filename;
    nameEl.title = item.filename;
    
    infoEl.appendChild(badgeEl);
    infoEl.appendChild(nameEl);
    
    const btnEl = document.createElement('button');
    btnEl.className = 'media-btn';
    btnEl.type = 'button';
    btnEl.innerHTML = '📥';
    btnEl.title = 'Download with MIXDM';
    
    btnEl.addEventListener('click', async () => {
      btnEl.disabled = true;
      showMessage('Sending stream to MIXDM...');
      
      const payload = {
        url: item.url,
        title: item.filename.replace(/\.[^/.]+$/, ""), // strip extension for title
        filename: item.filename,
        source: 'extension-grabber',
        referer: activeTab?.url || '',
        tabUrl: activeTab?.url || ''
      };
      
      const response = await sendMessage({ type: 'MIXDM_DOWNLOAD', payload });
      btnEl.disabled = false;
      
      if (response?.ok) {
        showMessage('Stream sent to MIXDM!', 'success');
      } else {
        showMessage(response?.error || 'Could not download stream.', 'error');
      }
    });
    
    itemEl.appendChild(infoEl);
    itemEl.appendChild(btnEl);
    container.appendChild(itemEl);
  });
}

function updateInterceptUI(enabled) {
  if (!els.interceptToggle || !els.interceptSub) return;
  els.interceptToggle.checked = enabled;
  if (enabled) {
    els.interceptSub.textContent = 'ON — Chrome downloads sent to MIXDM';
    els.interceptSub.className = 'intercept-sub on';
  } else {
    els.interceptSub.textContent = 'OFF — Click to enable';
    els.interceptSub.className = 'intercept-sub off';
  }
}

async function loadInterceptStatus() {
  const res = await sendMessage({ type: 'MIXDM_GET_INTERCEPT_STATUS' });
  if (res?.ok) {
    updateInterceptUI(res.enabled);
  } else {
    updateInterceptUI(false);
  }
}

async function init() {
  // Apply active theme
  const themeRes = await sendMessage({ type: 'MIXDM_GET_THEME' });
  if (themeRes?.ok && themeRes.theme === 'shushutan') {
    document.documentElement.classList.add('theme-shushutan');
  } else {
    document.documentElement.classList.remove('theme-shushutan');
  }

  activeTab = await queryActiveTab();
  els.tabTitle.textContent = activeTab?.title || 'No active tab';
  els.tabUrl.textContent = activeTab?.url || '';

  const canUseTab = isHttpUrl(activeTab?.url || '');
  els.download.disabled = !canUseTab;
  els.openOptions.disabled = !canUseTab;
  if (els.toggleFloating) els.toggleFloating.disabled = !canUseTab;

  if (!canUseTab) {
    showMessage('This tab cannot be sent to MIXDM.', 'error');
  }

  await refreshStatus();
  await loadInterceptStatus();

  if (activeTab && activeTab.id !== undefined) {
    const res = await sendMessage({ type: 'MIXDM_GET_DETECTED_MEDIA', tabId: activeTab.id });
    if (res?.ok) {
      renderDetectedMedia(res.media);
    }

    if (canUseTab) {
      const status = await sendTabMessage({ type: 'MIXDM_GET_BUTTON_STATUS' });
      if (status && status.ok) {
        updateToggleButtonUI(status.isHidden);
      } else {
        if (els.toggleFloating) els.toggleFloating.disabled = true;
      }
    }
  } else {
    if (els.toggleFloating) els.toggleFloating.disabled = true;
  }
}

els.download.addEventListener('click', async () => {
  setBusy(true);
  showMessage('Sending to MIXDM...');
  const response = await sendMessage({ type: 'MIXDM_DOWNLOAD', payload: tabPayload() });
  setBusy(false);

  if (response?.ok) {
    showMessage('Download started in MIXDM.', 'success');
  } else {
    showMessage(response?.error || 'Could not start download.', 'error');
  }
});

els.openOptions.addEventListener('click', async () => {
  setBusy(true);
  const response = await sendMessage({ type: 'MIXDM_OPEN_ANALYZE', payload: tabPayload() });
  setBusy(false);

  if (response?.ok) {
    showMessage('Opened in MIXDM.', 'success');
  } else {
    showMessage(response?.error || 'Could not open MIXDM.', 'error');
  }
});

els.refresh.addEventListener('click', refreshStatus);

// Intercept toggle
if (els.interceptToggle) {
  els.interceptToggle.addEventListener('change', async () => {
    const enabled = els.interceptToggle.checked;
    // Optimistically update UI
    updateInterceptUI(enabled);
    const res = await sendMessage({ type: 'MIXDM_SET_INTERCEPT', enabled });
    if (!res?.ok) {
      // Revert on failure
      updateInterceptUI(!enabled);
      showMessage('Could not update intercept setting.', 'error');
    } else {
      showMessage(
        enabled ? 'Interception enabled — Chrome downloads go to MIXDM.' : 'Interception disabled.',
        enabled ? 'success' : ''
      );
    }
  });
}

if (els.toggleFloating) {
  els.toggleFloating.addEventListener('click', async () => {
    els.toggleFloating.disabled = true;
    const response = await sendTabMessage({ type: 'MIXDM_TOGGLE_BUTTON' });
    els.toggleFloating.disabled = false;
    if (response && response.ok) {
      updateToggleButtonUI(response.isHidden);
    }
  });
}

init();
