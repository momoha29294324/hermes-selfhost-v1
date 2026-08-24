#!/usr/bin/env bash
# Garde-fous automatiques pour Hermes, en defense en profondeur de CLAUDE.md.
#
# CLAUDE.md est du CONTEXTE lu par un modele : il est pondere, parfois oublie.
# Ce hook, lui, s'execute. Il bloque ce que CLAUDE.md interdit deja en toutes
# lettres, pour que l'interdiction tienne meme si l'instruction est mal suivie.
#
# Il ne couvre QUE des commandes Bash. Les gardes qui decident vraiment vivent
# dans le code (crochet pre-effet, plafonds, arret global, activation) et sont
# revalidees de toute facon.
set -euo pipefail

input="$(cat)"
tool_name="$(jq -r '.tool_name // empty' <<<"$input")"
[ "$tool_name" = "Bash" ] || exit 0

command="$(jq -r '.tool_input.command // empty' <<<"$input")"
[ -n "$command" ] || exit 0

deny() {
  jq -n --arg reason "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
  exit 0
}

# ---------------------------------------------------------------------------
# 1. Armer l'envoi
# ---------------------------------------------------------------------------
# OUTBOUND_ALLOW_SENDING=1 est l'armement d'envoi ephemere. Il est refuse ici.
#
# Ce n'est pas une precaution de developpement : cette variable est ce qui
# separe « Hermes a prepare un message » de « Hermes l'a remis a quelqu'un ».
# Un agent ne se l'accorde pas a lui-meme. Si vous, operateur humain, decidez
# de l'exercer, faites-le depuis VOTRE terminal, hors session d'agent, et
# apres avoir lu ce que la commande va faire.
if grep -qE "OUTBOUND_ALLOW_SENDING[[:space:]]*=[[:space:]]*['\"]?1" <<<"$command"; then
  deny "L'envoi reel est refuse depuis une session d'agent.
Cette variable arme la remise effective d'un message a une personne reelle.
La decision appartient a un operateur humain, prise en connaissance de cause, depuis son propre terminal.
Tout le reste — preparer, previsualiser, rediger, certifier — fonctionne sans elle."
fi

# ---------------------------------------------------------------------------
# 2. Joindre un fournisseur d'envoi A LA MAIN
# ---------------------------------------------------------------------------
# Le seul chemin d'envoi est le dispatcher audite : lui seul relit le manifeste
# verrouille, verifie le destinataire, l'empreinte du texte et l'idempotence.
# Un curl ecrit a la main contourne TOUT cela, en ayant l'air anodin, et avec
# la meme cle d'API.
if grep -qE "api\.resend\.com|api\.sendgrid\.com|api\.mailgun\.net|api\.postmarkapp\.com" <<<"$command"; then
  deny "Aucun appel direct a un fournisseur d'envoi. Le seul chemin autorise est « npm run r6b:dispatch », qui revalide le manifeste verrouille et construit lui-meme le payload."
fi

# Un CRM n'est pas qu'un CRM : le meme hote, avec le meme jeton, expedie aussi
# email, SMS et messages. Un appel a la main court-circuite a la fois la
# confirmation de sous-compte et l'interdiction d'envoi, en ayant l'air d'une
# simple lecture.
if grep -qE "leadconnectorhq\.com|services\.leadconnector" <<<"$command"; then
  deny "Aucun appel direct au CRM. Le meme hote expedie aussi des messages. Passer par « npm run r6b:crm:verify » (lecture seule) ou « npm run r6b:crm:sync »."
fi

# La messagerie sociale n'est joignable que par le rail navigateur, dont la
# garde reseau refuse toute requete d'effet — message, follow, like,
# commentaire — avant qu'elle ne sorte du processus. Un curl portant les
# cookies de la session persistante enverrait un vrai message en ayant l'air
# d'un simple appel d'API.
if grep -qE "i\.instagram\.com|graph\.instagram\.com|graph\.facebook\.com|instagram\.com/api/|/direct_v2/" <<<"$command"; then
  deny "Aucun appel direct a l'API de messagerie. Le seul chemin autorise est le rail navigateur (« npm run ig:dry-run », lecture seule), qui refuse toute requete d'effet."
fi

# ---------------------------------------------------------------------------
# 3. Reecrire l'historique partage
# ---------------------------------------------------------------------------
if grep -qE "git[[:space:]]+push[[:space:]].*(--force|-f\b)" <<<"$command"; then
  deny "Force-push bloque par defaut. Confirmer explicitement avec l'utilisateur d'abord."
fi
if grep -qE "git[[:space:]]+(reset[[:space:]]+--hard|checkout[[:space:]]+main\b|switch[[:space:]]+main\b)" <<<"$command"; then
  deny "Commande touchant main ou reecrivant l'historique local bloquee par defaut. Confirmer explicitement avec l'utilisateur d'abord."
fi

# ---------------------------------------------------------------------------
# 4. Indexer un vrai .env
# ---------------------------------------------------------------------------
# .env.example reste permis : il ne contient aucune valeur.
if grep -qE "git[[:space:]]+add\b" <<<"$command" \
   && grep -qE "(^|[[:space:]])\.env([[:space:]]|$)|(^|[[:space:]])\.env\.local([[:space:]]|$)" <<<"$command"; then
  deny "Aucun secret dans Git — .env ne doit jamais etre ajoute a l'index."
fi
if grep -qE "git[[:space:]]+commit\b" <<<"$command"; then
  staged="$(git diff --cached --name-only 2>/dev/null || true)"
  if grep -qE "^\.env$|^\.env\.local$" <<<"$staged"; then
    deny ".env est indexe — le retirer (git restore --staged .env) avant de committer."
  fi
fi

exit 0
