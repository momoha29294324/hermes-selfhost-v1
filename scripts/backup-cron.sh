#!/bin/sh
# Lancé quotidiennement par le planificateur du système (launchd, cron, systemd timer).
# Exécute le mécanisme de backup officiel (`npm run db:backup`) — jamais de
# logique de backup dupliquée ici. `npm run db:backup` acquiert lui-même le
# verrou cross-process PGlite et échoue proprement si un autre process
# (dashboard ou CLI) détient déjà le datadir.
set -eu

# Le depot est celui qui CONTIENT ce script — pas un chemin recopie. Un chemin
# en dur pointerait le mauvais depot au premier deplacement, et sur une autre
# machine il ne pointerait rien du tout.
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN_DIR="${HERMES_NODE_BIN_DIR:-$(dirname "$(command -v node || echo /usr/local/bin/node)")}"

export PATH="$NODE_BIN_DIR:/usr/bin:/bin:/usr/sbin:/sbin"

cd "$REPO_DIR"
exec "$NODE_BIN_DIR/npm" run db:backup
