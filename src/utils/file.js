const path = require('path');
const os = require('os');

const DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads', 'MIXDM');

function validateDownloadUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('URL is required');
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP/HTTPS URLs are supported');
  }
  return parsed.href;
}

module.exports = {
  DOWNLOADS_DIR,
  validateDownloadUrl
};
