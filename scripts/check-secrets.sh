#!/usr/bin/env bash
# Scan déterministe de secrets, avant tout push externe (CLAUDE.md §6).
# Usage: scripts/check-secrets.sh [ref-de-base]
#   Sans argument : scanne seulement le working tree suivi par Git.
#   Avec un ref (ex. `main`, un SHA) : scanne aussi l'historique ref..HEAD.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

BASE="${1:-}"
FAIL=0

# Formes de clés/tokens qu'on reconnaît sans ambiguïté. Volontairement
# spécifique (pas de règle générique "20 caractères aléatoires") pour éviter
# les faux positifs sur des hash, des UUID ou des exemples.
PATTERNS='(AKIA[0-9A-Z]{16})|(sk-ant-[A-Za-z0-9_-]{20,})|(sk-[A-Za-z0-9]{20,})|(AIza[0-9A-Za-z_-]{20,})|(xox[baprs]-[0-9A-Za-z-]{10,})|(-----BEGIN [A-Z ]*PRIVATE KEY-----)|(eyJhbGciOi[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})'

echo "→ Fichiers suivis (working tree, hors .env.example) :"
tracked_hits="$(git grep -InE "$PATTERNS" -- . ':(exclude).env.example' 2>/dev/null || true)"
if [ -n "$tracked_hits" ]; then
  echo "❌ Motif ressemblant à un secret dans un fichier suivi :"
  echo "$tracked_hits"
  FAIL=1
else
  echo "  rien trouvé."
fi

if [ -n "$BASE" ]; then
  echo "→ Historique ${BASE}..HEAD :"
  hist_hits="$(git log -p "${BASE}..HEAD" -- . ':(exclude).env.example' 2>/dev/null | grep -E '^\+' | grep -E "$PATTERNS" || true)"
  if [ -n "$hist_hits" ]; then
    echo "❌ Motif ressemblant à un secret introduit entre ${BASE} et HEAD :"
    echo "$hist_hits"
    FAIL=1
  else
    echo "  rien trouvé."
  fi
fi

echo "→ .env jamais committé dans l'historique :"
env_added="$(git log --all --diff-filter=A --name-only -- '.env' '.env.local' '**/.env' 2>/dev/null || true)"
if [ -n "$env_added" ]; then
  echo "❌ Un fichier .env a été committé dans l'historique :"
  echo "$env_added"
  FAIL=1
else
  echo "  rien trouvé."
fi

if [ "$FAIL" -ne 0 ]; then
  echo
  echo "Scan de secrets : ÉCHEC — ne pas pousser tant que ce qui précède n'est pas résolu." >&2
  exit 1
fi
echo
echo "✅ Scan de secrets : rien trouvé."
