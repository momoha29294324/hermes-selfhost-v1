#!/bin/sh
# IG5 R4 — la relève entrante Instagram, tenue par launchd.
#
# Lancé par le LaunchAgent `com.hermes.hermes.ig-inbound`
# (gabarit versionné : deploy/launchd/, procédure : la documentation d’installation).
#
# Ce script n'ordonnance RIEN. Il ne compte pas les minutes, ne tient aucun
# verrou, ne décide d'aucun recul : tout cela vit déjà dans le runtime IG5.2A
# (`decideInboundTick`, bail `ig_inbound_polls`, recul exponentiel), qui est la
# seule autorité sur la cadence. Un `sleep` écrit ici serait un second
# ordonnanceur — exactement ce que R4 interdit. Le rôle de ce fichier tient en
# deux lignes : donner un PATH au processus, et le lancer.
#
# launchd, lui, apporte la seule chose que le runtime ne peut pas s'apporter à
# lui-même : le redémarrage après un crash, et le démarrage à l'ouverture de
# session.
set -eu

# Le dépôt est celui qui CONTIENT ce script — pas un chemin recopié. Un chemin
# en dur aurait pointé le mauvais profil au premier déplacement, et c'est
# exactement ce qui a failli arriver : ce commentaire affirmait encore « le rail
# entrant tourne dans le worktree R7 » alors que le LaunchAgent avait été
# repointé sur le workspace canonique depuis. La ligne ci-dessous, elle, était
# restée juste — c'est la propriété qui compte, pas la phrase qui la décrit.
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Le repertoire des binaires Node.
#
# `command -v node` plutot qu'un chemin ecrit en dur : ce script est lance par
# launchd, qui ne donne aucun PATH utilisable — mais l'installation, elle, sait
# ou Node vit. `HERMES_NODE_BIN_DIR` reste la surcharge explicite quand Node
# n'est pas sur le PATH du shell d'installation (nvm, asdf, Homebrew).
NODE_BIN_DIR="${HERMES_NODE_BIN_DIR:-$(dirname "$(command -v node || echo /usr/local/bin/node)")}"

# Le classifieur entrant n'est pas un module : c'est le binaire `codex`, que
# `CodexCliProvider` lance par son nom nu (`OUTBOUND_CODEX_BIN`, défaut
# « codex »). Le PATH ci-dessous est CONSTRUIT, pas hérité — c'est délibéré,
# launchd n'en donne aucun d'utilisable — mais tant qu'il ne listait que Node
# et les répertoires système, `spawn('codex')` sortait en ENOENT et chaque
# message entrant restait non classé. Le rail ne tombait pas : il tournait
# aveugle, ce qui est pire, parce que rien ne s'arrêtait pour le signaler.
#
# `$HOME` et non `~` : c'est /bin/sh qui développe cette ligne, pas launchd —
# lui ne développe pas le tilde, et un `~/.local/bin` écrit dans le plist
# aurait produit un répertoire littéral que rien n'aurait signalé.
CODEX_BIN_DIR="${HERMES_CODEX_BIN_DIR:-$HOME/.local/bin}"

export PATH="$NODE_BIN_DIR:$CODEX_BIN_DIR:/usr/bin:/bin:/usr/sbin:/sbin"

# L'arrêt des effets SORTANTS, réaffirmé dans l'environnement du processus.
# Le rail entrant n'a de toute façon aucune primitive d'envoi — le runtime et
# le collecteur refusent de tourner si l'objet qu'on leur passe en expose une,
# et la garde réseau refuse qu'une requête d'effet sorte du processus. Cette
# ligne n'ajoute pas de sécurité : elle interdit qu'un environnement hérité
# fasse croire le contraire à quelqu'un qui lirait ce fichier.
export OUTBOUND_ALLOW_SENDING=0

cd "$REPO_DIR"
# `--loop` : le runtime relit son état en base à chaque tour et dort la durée
# que la DÉCISION lui donne. Un redémarrage — crash, reboot, `launchctl
# kickstart` — reprend donc exactement la cadence qu'un processus jamais tué
# aurait tenue, parce qu'aucune de ces durées ne vit en mémoire.
exec "$NODE_BIN_DIR/npm" run ig:inbound:run -- --loop
