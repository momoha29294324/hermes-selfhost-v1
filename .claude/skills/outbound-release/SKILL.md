---
name: outbound-release
description: >
  Checklist technique avant de livrer ou fusionner du code Hermes :
  git status/diff, `npm run validate`, migrations, scan de secrets, scan
  d'isolation, confirmation qu'aucun envoi n'a eu lieu. À utiliser avant un
  commit de livraison, une préparation de PR, ou une fusion vers `main`.
when_to_use: >
  "Prépare la livraison", "est-ce que c'est prêt à merger", "fais la
  checklist avant de committer". Pas pour une simple exploration ou lecture
  de code sans intention de livrer.
---

# Checklist de livraison — Hermes

Exécuter dans l'ordre, s'arrêter au premier échec réel :

```bash
git status && git diff --stat main...HEAD   # ce qui a changé, et rien d'autre
npm run validate                             # typecheck + lint + tests
scripts/check-secrets.sh main                # aucun secret introduit
```

Puis, à la main :

- **Migrations** : toute modification de schéma est une **nouvelle** migration
  dans `db/migrations/` — jamais une modification d'une migration déjà
  appliquée (le runner refuse par checksum, mais vérifier `git diff` ne
  touche aucun fichier de migration existant).
- **Isolation** (`CLAUDE.md` §4, la documentation d’installation) : rien touché hors de
  ce dépôt — pas de profil Hermes autre que le sien, pas de service partagé
  reconfiguré.
- **0 envoi** : `OUTBOUND_ALLOW_SENDING` reste `0` dans `.env.example` et
  dans le code ; aucune ligne `outreach_events` de type `sent`/`delivered`
  n'a été créée pendant la session (si une campagne a tourné, le confirmer
  avec `npm run gate:report`, critère 9).
- **Secrets** : `.env.example` ne contient que des exemples/valeurs vides ;
  aucun jeton, clé ou mot de passe dans un message, un log ou un commit.

## Commit et merge

Commits atomiques, message impératif court. Ne pas pousser vers `main` ni
fusionner sans validation explicite de l'utilisateur — surtout si une autre
session travaille en parallèle sur ce dépôt (vérifier `git worktree list`
avant de toucher à une branche qui n'est pas la sienne).

## Pour aller plus loin

- Skill `outbound-gate` pour la validation des *données* (GO/PARTIAL/FAIL) —
  distincte de cette checklist, qui porte sur le *code*. pour l'architecture Claude complète
  de ce dépôt.
