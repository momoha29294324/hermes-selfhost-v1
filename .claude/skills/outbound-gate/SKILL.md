---
name: outbound-gate
description: >
  Procédure de validation produit (GO/PARTIAL/FAIL) d'un lot de prospects
  Hermes, calculée depuis la base via `npm run gate:report` et
  `npm run review:table` — jamais depuis la mémoire de la conversation. À
  utiliser pour auditer une campagne, produire un rapport de gate, ou décider
  si un lot de prospects est livrable.
when_to_use: >
  "Fais le gate de la campagne X", "audite ce lot de prospects", "combien de
  prospects sont prêts", ou toute décision GO/PARTIAL/FAIL sur des données
  produit. Ne pas confondre avec `outbound-release`, qui est la checklist
  technique avant de livrer du code (git, tests, migrations) — le gate porte
  sur les données, pas sur le code.
---

# Gate produit — Hermes

## Procédure

1. `npm run gate:report -- --campaign <slug> [--target 20]` — calcule les 9
   critères depuis la base (`src/cli/gate-report.ts`) : volume, dédup,
   evidence, classification, score, research, angle, message, **et 0
   envoi**. Ne pas recompter à la main ce que ce script calcule déjà.
2. `npm run review:table -- --campaign <slug>` — vue humaine des prospects
   pour une relecture qualitative (identité, parcours, message).
3. Lire les critères en échec avec leur `detail`, pas seulement le total.
4. Vérifier `CLAUDE.md` §1 : `OUTBOUND_ALLOW_SENDING` reste à 0, et le
   critère "Personne n'a été contacté" est vert.

## Verdict

- **GO** — tous les critères passent, les limites connues sont dites
  franchement dans le rapport (pas cachées).
- **PARTIAL** — le cœur passe mais un critère secondaire ou une limite réelle
  empêche un GO franc ; dire précisément laquelle et ce qu'il faudrait pour
  lever le PARTIAL.
- **FAIL** — un critère bloquant échoue (volume, dédup, ou surtout le critère
  d'envoi).

## Rapport

Suivre le format de la documentation d’installation : Git (table de commits), Sous-agents
(nombre, justification), Découverte, Qualification, Enrichissement, Parcours
commercial, Commercial (scores), limites dites franchement, Verdict. Nommer
un compte rendu de gate daté, conservé par l’opérateur.

## Pour aller plus loin à la documentation d’installation — historique, pour voir comment le
  gate a évolué et quelles limites ont déjà été rencontrées.
- Skill `outbound-evidence` pour juger si une fiche individuelle est bien
  sourcée avant de la compter comme "prête".
