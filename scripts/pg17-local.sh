#!/usr/bin/env bash
#
# Jetable : cluster PostgreSQL local, UNIQUEMENT comme banc d'essai.
#
# Ce que ce script n'est PAS
# --------------------------
# Ce n'est pas la cible de déploiement. La cible de Hermes est le
# PostgreSQL managé d'un projet Supabase. Rien ici ne
# doit être promu en production, et `OUTBOUND_DATABASE_URL` en production ne
# pointe jamais sur ce cluster.
#
# À quoi il sert
# --------------
# À faire tourner hors ligne ce qu'on ne veut pas faire tourner sur la base
# managée :
#   * `tests/postgresConcurrency.test.ts`, qui crée, verrouille et tronque des
#     lignes — un test n'a rien à faire dans une base Supabase Pro ;
#   * la répétition à blanc du transfert et de sa vérification, avant de la
#     jouer une seule fois pour de vrai vers Supabase.
#
# Il est donc facultatif. Si vous ne voulez pas de cluster local, ne le lancez
# pas : la suite de tests saute d'elle-même les tests Postgres quand
# OUTBOUND_TEST_DATABASE_URL est absent, et `var/pg17/` peut être supprimé sans
# conséquence.
#
# Ce à quoi il ne touche jamais
# -----------------------------
# `var/pgdata` — le datadir PGlite qui contient le corpus de 286 prospects. Ce
# script ne crée et ne gère que `var/pg17/`. Aucun chemin de code ici ne
# supprime, ne déplace ni n'écrit dans `var/pgdata`.
#
# Usage
# -----
#   scripts/pg17-local.sh init     # initdb + start + création rôle/bases
#   scripts/pg17-local.sh start
#   scripts/pg17-local.sh stop
#   scripts/pg17-local.sh status
#   scripts/pg17-local.sh psql [args...]
#
# L'URL de connexion générée est écrite dans var/pg17/connection.env, sous
# l'arbre `var/` qui est gitignoré. Elle n'est jamais imprimée en entier.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

PGHOME="${HERMES_PG17_HOME:-/opt/homebrew/opt/postgresql@17}"
PORT="${HERMES_PG_PORT:-5433}"
CLUSTER="var/pg17"
PGDATA="${CLUSTER}/data"
LOGFILE="${CLUSTER}/postgres.log"
CONNFILE="${CLUSTER}/connection.env"
DBNAME="${HERMES_PG_DATABASE:-hermes_outbound}"
DBUSER="${HERMES_PG_USER:-hermes}"
TESTDB="${HERMES_PG_TEST_DATABASE:-${DBNAME}_test}"

if [ ! -x "${PGHOME}/bin/pg_ctl" ]; then
  echo "❌ PostgreSQL 17 introuvable dans ${PGHOME}." >&2
  echo "   Installez-le (brew install postgresql@17) ou pointez HERMES_PG17_HOME." >&2
  exit 1
fi

export PATH="${PGHOME}/bin:${PATH}"

running() {
  pg_ctl -D "${PGDATA}" status >/dev/null 2>&1
}

# Les commandes d'administration passent par la socket Unix (auth `trust` pour
# l'utilisateur OS), jamais par TCP : le port 127.0.0.1 est en `scram-sha-256`
# et le superutilisateur du cluster n'a volontairement pas de mot de passe.
admin_psql() {
  psql -h /tmp -p "${PORT}" -d postgres "$@"
}

cmd_init() {
  if [ -f "${PGDATA}/PG_VERSION" ]; then
    echo "ℹ️  Cluster déjà initialisé dans ${PGDATA} (PG $(cat "${PGDATA}/PG_VERSION")). Rien à faire."
  else
    mkdir -p "${CLUSTER}"
    # Le superutilisateur du cluster est l'utilisateur OS courant, joignable par
    # la socket Unix ; le rôle applicatif créé plus bas est celui que l'appli
    # utilise, et lui a un mot de passe.
    initdb -D "${PGDATA}" \
      --encoding=UTF8 --locale=C \
      --auth-local=trust --auth-host=scram-sha-256 >/dev/null
    # Écoute uniquement la boucle locale : rien de ce cluster n'est exposé au
    # réseau, pas même au Tailnet.
    {
      echo "listen_addresses = '127.0.0.1'"
      echo "port = ${PORT}"
      echo "max_connections = 100"
      echo "log_line_prefix = '%m [%p] %q%u@%d '"
    } >> "${PGDATA}/postgresql.conf"
    echo "✅ Cluster initialisé : ${PGDATA}"
  fi

  cmd_start

  # Mot de passe : fourni par l'environnement, sinon généré. Jamais en dur dans
  # ce fichier, jamais imprimé, jamais versionné (var/ est gitignoré).
  # `| head` fermerait le tube et tuerait le producteur : sous `pipefail`, le
  # SIGPIPE (141) ferait sortir `set -e` avant d'avoir créé le rôle. Les deux
  # branches ci-dessous sont donc sans tube.
  local password
  if [ -n "${HERMES_PG_PASSWORD:-}" ]; then
    password="${HERMES_PG_PASSWORD}"
  elif [ -f "${CONNFILE}" ]; then
    # Ancré sur OUTBOUND_DATABASE_URL : le fichier contient plusieurs lignes et
    # une seule correspond, donc pas de `q` (qui s'arrêterait à la première
    # ligne) ni de `head` (qui déclencherait un SIGPIPE sous `pipefail`).
    password="$(sed -n 's#^OUTBOUND_DATABASE_URL=.*://[^:]*:\([^@]*\)@.*#\1#p' "${CONNFILE}")"
  else
    password="$(openssl rand -hex 24)"
  fi
  if [ -z "${password}" ]; then
    echo "❌ Impossible de déterminer un mot de passe pour ${DBUSER}." >&2
    exit 1
  fi

  if [ -z "$(admin_psql -tAc "select 1 from pg_roles where rolname='${DBUSER}'")" ]; then
    admin_psql -q -c "create role ${DBUSER} login password '${password}'"
    echo "✅ Rôle ${DBUSER} créé."
  else
    admin_psql -q -c "alter role ${DBUSER} login password '${password}'"
    echo "ℹ️  Rôle ${DBUSER} déjà présent (mot de passe réaligné)."
  fi

  if [ -z "$(admin_psql -tAc "select 1 from pg_database where datname='${DBNAME}'")" ]; then
    admin_psql -q -c "create database ${DBNAME} owner ${DBUSER}"
    echo "✅ Base ${DBNAME} créée."
  else
    echo "ℹ️  Base ${DBNAME} déjà présente — conservée telle quelle."
  fi

  # Base jetable pour les tests de concurrence. Séparée de ${DBNAME} pour qu'un
  # test ne puisse pas, même par erreur, écrire dans le corpus.
  if [ -z "$(admin_psql -tAc "select 1 from pg_database where datname='${TESTDB}'")" ]; then
    admin_psql -q -c "create database ${TESTDB} owner ${DBUSER}"
    echo "✅ Base de test ${TESTDB} créée."
  else
    echo "ℹ️  Base de test ${TESTDB} déjà présente."
  fi

  umask 077
  {
    printf 'OUTBOUND_DB_BACKEND=postgres\n'
    printf 'OUTBOUND_DATABASE_URL=postgresql://%s:%s@127.0.0.1:%s/%s\n' \
      "${DBUSER}" "${password}" "${PORT}" "${DBNAME}"
    printf 'OUTBOUND_TEST_DATABASE_URL=postgresql://%s:%s@127.0.0.1:%s/%s\n' \
      "${DBUSER}" "${password}" "${PORT}" "${TESTDB}"
  } > "${CONNFILE}"
  chmod 600 "${CONNFILE}"

  echo
  echo "✅ Banc d'essai PostgreSQL 17 prêt sur 127.0.0.1:${PORT} (base ${DBNAME}, rôle ${DBUSER})."
  echo "   ⚠️  Banc d'essai uniquement — la cible de production est Supabase."
  echo "   URL de connexion écrite dans ${CONNFILE} (chmod 600, sous var/ donc gitignoré)."
  echo "   Pour les tests de concurrence :  set -a && source ${CONNFILE} && set +a"
}

cmd_start() {
  if running; then
    echo "ℹ️  Cluster déjà démarré (port ${PORT})."
    return
  fi
  mkdir -p "${CLUSTER}"
  pg_ctl -D "${PGDATA}" -l "${LOGFILE}" -o "-p ${PORT}" -w start >/dev/null
  echo "✅ Cluster démarré sur 127.0.0.1:${PORT} (log : ${LOGFILE})."
}

cmd_stop() {
  if ! running; then
    echo "ℹ️  Cluster déjà arrêté."
    return
  fi
  pg_ctl -D "${PGDATA}" -m fast -w stop >/dev/null
  echo "✅ Cluster arrêté."
}

cmd_status() {
  if running; then
    echo "✅ Cluster actif — $(admin_psql -tAc 'select version()' 2>/dev/null || echo 'socket injoignable')"
  else
    echo "⛔ Cluster arrêté (${PGDATA})."
  fi
}

case "${1:-status}" in
  init)   cmd_init ;;
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  psql)   shift; psql -h 127.0.0.1 -p "${PORT}" -d "${DBNAME}" -U "${DBUSER}" "$@" ;;
  *)      echo "Usage: scripts/pg17-local.sh {init|start|stop|status|psql}" >&2; exit 2 ;;
esac
