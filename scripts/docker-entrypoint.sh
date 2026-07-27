#!/bin/sh
# The server binds every interface inside the container's network namespace and
# says so: `[vinext] Production server running at http://0.0.0.0:3000`. That
# line reads like a URL and is the one people paste, but browsers do not treat
# `0.0.0.0` as a trustworthy origin and withhold web APIs from it. The app
# detects and explains that after the fact; this says it first, so the banner
# below is read as a caption for the log line that follows it.
set -e

PORT="${PORT:-3000}"

cat <<BANNER
────────────────────────────────────────────────────────────────
 Inference Lens
 Open  http://localhost:${PORT}  in your browser.
 (Map a different host port with -p and open that one instead.)

 The http://0.0.0.0:${PORT} address logged below is the address
 the server binds inside this container — not a URL to open.
────────────────────────────────────────────────────────────────
BANNER

exec "$@"
