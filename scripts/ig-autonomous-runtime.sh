#!/bin/sh
# Le worker LIVE autonome Instagram, tenu par launchd.
#
# Lancé par le LaunchAgent `com.hermes.hermes.ig-autonomous`
# (gabarit versionné : deploy/launchd/). Jumeau de `ig-inbound-runtime.sh`, et
# volontairement écrit dans le même moule : deux runtimes qui partagent une
# machine, une session Instagram et un profil navigateur ne doivent pas
# démarrer de deux façons différentes.
#
# Ce script n'ordonnance RIEN. Il ne compte pas les minutes, ne décide d'aucun
# envoi, ne lève aucun arrêt. La cadence appartient à la boucle interne du
# worker (`AUTONOMOUS_IDLE_POLL_MS`, dérivée du `not_before` de la file) ; les
# plafonds, l'espacement et la fenêtre appartiennent à `evaluateSafety` et
# `evaluateSchedule`, relus à chaque tour. Un `sleep` écrit ici serait un
# second ordonnanceur, et le plist n'en déclare pas non plus — ni
# StartInterval, ni StartCalendarInterval.
#
# launchd apporte la seule chose que le worker ne peut pas s'apporter à
# lui-même : le redémarrage après un crash, et le démarrage à l'ouverture de
# session.
set -eu

# Le dépôt est celui qui CONTIENT ce script — pas un chemin recopié. C'est ce
# qui garantit que le worker lit le `config/instagram.json`, le `.env` et le
# profil navigateur du workspace d'où il a été installé, et non ceux d'un
# worktree voisin resté ouvert.
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN_DIR="${HERMES_NODE_BIN_DIR:-/Users/mohamedchergui/.hermes/node/bin}"

# Même PATH construit que le rail entrant, et pour la même raison : launchd n'en
# donne aucun d'utilisable, et un binaire lancé par son nom nu sort en ENOENT
# sans que rien ne s'arrête pour le signaler.
CODEX_BIN_DIR="${HERMES_CODEX_BIN_DIR:-$HOME/.local/bin}"

export PATH="$NODE_BIN_DIR:$CODEX_BIN_DIR:/usr/bin:/bin:/usr/sbin:/sbin"

# L'arrêt des effets SORTANTS du rail R6B (email), réaffirmé dans
# l'environnement du processus.
#
# Ce n'est PAS ce qui retient ce worker-ci : le rail Instagram ne lit pas cette
# variable. Ce qui le retient est l'arrêt global en base — armé par défaut,
# levé seulement par un geste d'opérateur nommé — relu à chaque tour ET
# immédiatement avant chaque clic. Cette ligne interdit seulement qu'un
# environnement hérité ouvre AUTRE chose au passage.
export OUTBOUND_ALLOW_SENDING=0

cd "$REPO_DIR"
# `--loop` : le worker relit l'arrêt global, les plafonds, la fenêtre et la file
# en base à chaque tour, et dort la durée que la FILE lui donne. Un redémarrage
# — crash, reboot, `launchctl kickstart` — reprend donc exactement la posture
# qu'un processus jamais tué aurait tenue, parce qu'aucune de ces décisions ne
# vit en mémoire. La commande n'a ni `--send`, ni `--all`, ni `--batch`, et ne
# sait pas lever l'arrêt global.
exec "$NODE_BIN_DIR/npm" run ig:autonomous:worker -- --loop
