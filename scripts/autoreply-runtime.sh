#!/bin/sh
# Le runtime d'AUTO-RÉPONSE Hermes, tenu par launchd.
#
# Lancé par le LaunchAgent `com.hermes.hermes.autoreply`
# (gabarit versionné : deploy/launchd/). Troisième frère de
# `ig-inbound-runtime.sh` et `ig-autonomous-runtime.sh`, et volontairement
# écrit dans le même moule : trois runtimes qui partagent une machine, une
# session Instagram et un profil navigateur ne doivent pas démarrer de trois
# façons différentes.
#
# Ce script n'ordonnance RIEN. Il ne compte pas les minutes, ne décide d'aucun
# envoi, n'arme aucune frontière, ne lève aucun arrêt. La cadence appartient à
# la boucle interne du runtime (`AUTO_REPLY_IDLE_POLL_MS`) ; les plafonds,
# l'espacement et la fenêtre appartiennent à `evaluateSafety` et
# `evaluateSchedule`, relus immédiatement avant chaque clic. Un `sleep` écrit
# ici serait un second ordonnanceur, et le plist n'en déclare pas non plus —
# ni StartInterval, ni StartCalendarInterval.
#
# Ce que ce runtime ne peut PAS faire, même chargé : répondre alors qu'aucune
# activation ne vit. Sans ligne `hermes_autoreply_activations` vivante, il
# regarde, le dit, et attend. Armer la frontière est un geste d'opérateur
# nommé, dans une AUTRE commande.
#
# launchd apporte la seule chose que le runtime ne peut pas s'apporter à
# lui-même : le redémarrage après un crash, et le démarrage à l'ouverture de
# session.
set -eu

# Le dépôt est celui qui CONTIENT ce script — pas un chemin recopié.
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN_DIR="${HERMES_NODE_BIN_DIR:-/Users/mohamedchergui/.hermes/node/bin}"

# Même PATH construit que les deux autres rails, et pour la même raison :
# launchd n'en donne aucun d'utilisable, et un binaire lancé par son nom nu
# sort en ENOENT sans que rien ne s'arrête pour le signaler.
CODEX_BIN_DIR="${HERMES_CODEX_BIN_DIR:-$HOME/.local/bin}"

export PATH="$NODE_BIN_DIR:$CODEX_BIN_DIR:/usr/bin:/bin:/usr/sbin:/sbin"

# L'arrêt des effets SORTANTS du rail R6B (email), réaffirmé dans
# l'environnement du processus.
#
# Ce n'est PAS ce qui retient ce runtime-ci : le rail Instagram ne lit pas cette
# variable. Ce qui le retient est, dans l'ordre, l'absence d'activation,
# l'arrêt global en base, les plafonds, la fenêtre, la cadence et les quinze
# portes du crochet pré-effet. Cette ligne interdit seulement qu'un
# environnement hérité ouvre AUTRE chose au passage.
export OUTBOUND_ALLOW_SENDING=0

cd "$REPO_DIR"
# `--loop` : le runtime relit l'activation, l'arrêt global, les plafonds, la
# fenêtre et le registre à chaque cycle, et rend le profil navigateur entre
# deux tours. Un redémarrage — crash, reboot, `launchctl kickstart` — reprend
# donc exactement la posture qu'un processus jamais tué aurait tenue, la
# FRONTIÈRE comprise : elle vit en base, pas en mémoire. La commande n'a ni
# `--all`, ni `--batch`, ni `--prospect`, ni `--force`, et ne sait ni s'activer
# elle-même, ni lever l'arrêt global.
exec "$NODE_BIN_DIR/npm" run autoreply:worker -- --loop
