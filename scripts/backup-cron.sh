#!/bin/sh
# Lancé quotidiennement par le planificateur du système (launchd, cron, systemd timer).
# Exécute le mécanisme de backup officiel (`npm run db:backup`) — jamais de
# logique de backup dupliquée ici. `npm run db:backup` acquiert lui-même le
# verrou cross-process PGlite et échoue proprement si un autre process
# (dashboard ou CLI) détient déjà le datadir.
set -eu

REPO_DIR="/Users/mohamedchergui/Developer/hermes"
NODE_BIN_DIR="/Users/mohamedchergui/.hermes/node/bin"

export PATH="$NODE_BIN_DIR:/usr/bin:/bin:/usr/sbin:/sbin"

cd "$REPO_DIR"
exec "$NODE_BIN_DIR/npm" run db:backup
