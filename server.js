'use strict';
// Entry point for the hosted desk on Render (start command: node server.js).
// On the PC, use "Open Dashboard.cmd" or: node dashboard/cli.js serve --open
// What hosted mode needs, and how it refuses to start without it, is in
// dashboard/hosted.js.

require('./dashboard/hosted').main().catch((err) => {
  console.error(`CryptoResearch (hosted) failed to start: ${err.message}`);
  process.exit(1);
});
