# MIXDM Browser Extension

This is the first local browser connector for MIXDM.

## Load in Chrome or Edge

1. Start MIXDM with `npm start`.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable Developer mode.
4. Choose Load unpacked.
5. Select this `extension` folder.
6. Copy the extension ID shown by Chrome/Edge and start MIXDM with
   `MIXDM_ALLOWED_EXTENSION_ORIGINS=chrome-extension://YOUR_EXTENSION_ID`.

## What it does

- Adds a MIXDM button on YouTube and X/Twitter status pages.
- Adds right-click menu actions for pages, links, videos, audio, and images.
- Sends captured URLs to `http://localhost:3737/api/extension/capture`.
- Opens/focuses the MIXDM app at `http://localhost:3737` after starting a job.
- Upgrades X/Twitter image URLs from `name=small/medium/large` to `name=orig`.
