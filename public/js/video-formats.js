/* ════════════════════════════════════════════════════
   MIXDM Frontend — video-formats.js
   Platform detection, YouTube/Social media helper, video formats
   ════════════════════════════════════════════════════ */

// ── URL Detection (mirrors server-side) ────────────────────────────────────────
const YT_PATTERNS = [
  /(?:youtube\.com\/(?:watch|shorts|live|embed|v|clip)|youtu\.be\/)/i,
  /(?:twitter\.com|x\.com)\/\w+\/status\//i,
  /(?:facebook\.com|fb\.watch|fb\.me)/i,
  /instagram\.com\/(?:p|reel|tv)\//i,
  /tiktok\.com\/@[\w.]+\/video\//i,
  /vm\.tiktok\.com\//i,
  /reddit\.com\/r\/\w+\/comments\//i,
  /twitch\.tv\/(?:videos\/|clips\/|\w+\/clip\/)/i,
  /vimeo\.com\/\d+/i,
  /dailymotion\.com\/video\//i,
  /bilibili\.com\/video\//i,
  /soundcloud\.com\/[\w-]+\/[\w-]+/i,
];

function looksLikeYt(url) {
  try { return YT_PATTERNS.some(p => p.test(url)); } catch { return false; }
}

function detectPlatformFE(url) {
  if (/youtu/i.test(url)) return 'YouTube';
  if (/twitter\.com|x\.com/i.test(url)) return 'Twitter/X';
  if (/facebook|fb\./i.test(url)) return 'Facebook';
  if (/instagram/i.test(url)) return 'Instagram';
  if (/tiktok/i.test(url)) return 'TikTok';
  if (/reddit/i.test(url)) return 'Reddit';
  if (/twitch/i.test(url)) return 'Twitch';
  if (/vimeo/i.test(url)) return 'Vimeo';
  if (/dailymotion/i.test(url)) return 'Dailymotion';
  if (/bilibili/i.test(url)) return 'Bilibili';
  if (/soundcloud/i.test(url)) return 'SoundCloud';
  return 'Social';
}

function platformCssClass(platform) {
  const map = {
    'YouTube': 'youtube', 'Twitter/X': 'twitter',
    'Facebook': 'facebook', 'Instagram': 'instagram',
    'TikTok': 'tiktok'
  };
  return map[platform] || 'default';
}

// ── Panel Mode Switch ──────────────────────────────────────
function setYtMode(on) {
  isYtMode = on;
  const panel = $('add-panel');
  const btnDl = $('btn-download');

  if (on) {
    panel.classList.add('yt-mode');
    $('panel-icon').textContent = '▶️';
    $('panel-label').textContent = 'YouTube / Social Media Download';
    $('url-input').classList.add('yt-detected');
    $('conn-label').style.display = 'none';
    $('seg-count').style.display = 'none';
    $('quality-label').style.display = '';
    $('format-select').classList.add('show');
    btnDl.className = 'btn btn-yt';
    btnDl.textContent = '▶ Download Video';
  } else {
    panel.classList.remove('yt-mode');
    $('panel-icon').textContent = '⬇️';
    $('panel-label').textContent = 'New Download';
    $('url-input').classList.remove('yt-detected');
    $('conn-label').style.display = '';
    $('seg-count').style.display = '';
    $('quality-label').style.display = 'none';
    $('format-select').classList.remove('show');
    $('video-preview').classList.remove('show');
    btnDl.className = 'btn btn-primary';
    btnDl.textContent = '⬇ Download';
  }
}

function showVideoPreview(info) {
  $('video-thumb').src = info.thumbnail || '';
  $('video-title').textContent = info.title || '';
  const platform = info.platform || detectPlatformFE($('url-input').value);
  const badge = $('platform-badge');
  badge.textContent = platform;
  badge.className = `platform-badge ${platformCssClass(platform)}`;
  $('video-uploader').textContent = info.uploader ? `by ${info.uploader}` : '';
  $('video-duration').textContent = info.duration ? fmtDuration(info.duration) : '';
  $('video-preview').classList.add('show');

  // Populate format list from server
  if (info.formats && info.formats.length > 0) {
    const sel = $('format-select');
    sel.innerHTML = '';
    info.formats.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.value;
      opt.textContent = f.label;
      sel.appendChild(opt);
    });
  }
}
