/**
 * Prevent broken stdout/stderr pipes from crashing the Electron main process.
 * This can happen when the dev terminal or a parent pipe closes while MIXDM is
 * still writing yt-dlp/server logs.
 */

function isBrokenPipeError(err) {
  return err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED');
}

function installStreamErrorGuard(stream) {
  if (!stream || stream.__mixdmSafeConsoleGuarded) return;
  Object.defineProperty(stream, '__mixdmSafeConsoleGuarded', {
    value: true,
    enumerable: false
  });

  stream.on('error', (err) => {
    if (isBrokenPipeError(err)) return;
    throw err;
  });
}

function installSafeConsole() {
  if (console.__mixdmSafeConsoleInstalled) return;
  Object.defineProperty(console, '__mixdmSafeConsoleInstalled', {
    value: true,
    enumerable: false
  });

  installStreamErrorGuard(process.stdout);
  installStreamErrorGuard(process.stderr);

  for (const method of ['log', 'info', 'warn', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      try {
        original(...args);
      } catch (err) {
        if (!isBrokenPipeError(err)) throw err;
      }
    };
  }
}

module.exports = {
  installSafeConsole
};
