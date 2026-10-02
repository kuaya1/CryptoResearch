#!/bin/sh
# macOS / Linux launcher. Starts the dashboard on 127.0.0.1 and opens the browser.
cd "$(dirname "$0")/../.." || exit 1
exec node dashboard/cli.js serve --open
