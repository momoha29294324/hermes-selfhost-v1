---
name: outbound-benchmark
description: >
  Protocole de benchmark reproductible pour Hermes : corpus figé,
  mêmes entrées pour chaque candidat, évaluation à l'aveugle, Phase A (tri
  large, bon marché) puis Phase B (finalistes seulement), p50/p95, tokens,
  crédits, timeouts, qualité, et frontière de Pareto plutôt qu'un vainqueur
  unique. À utiliser pour comparer des workers, providers, modèles ou rails
  de découverte entre eux.
when_to_use: >
  "Benchmarke X vs Y", comparer la latence/qualité/coût de deux providers ou
  modèles, décider quel rail promouvoir, ou relire un rapport de benchmark
  existant. Pas pour une correction de bug ponctuelle ou une tâche sans
  comparaison de candidats.
---

# Benchmark reproductible — Hermes

## Protocole

1. **Figer le corpus avant de lancer quoi que ce soit** — `npm run
   bench:freeze` (voir `src/lib/bench/corpus.ts`). Les mêmes entrées servent à
   chaque candidat ; un corpus qui change entre deux runs invalide la
   comparaison.
2. **Mêmes entrées, mêmes conditions.** Aucun avantage de contexte, de prompt
   ou d'ordre à un candidat.
3. **Évaluation à l'aveugle** quand un jugement de qualité est nécessaire : le
   correcteur ne voit pas quel provider/modèle a produit quelle sortie tant
   qu'il n'a pas noté.
4. **Phase A → Phase B.** Un tri large et bon marché élimine d'abord les
   candidats clairement dominés ; seuls les finalistes passent la Phase B,
   plus coûteuse (volume plus grand, modèle juge plus cher, etc.). Ne pas
   payer le coût complet pour un candidat déjà éliminé.
5. **Mesurer, ne pas déclarer.** Chaque candidat rapporte : p50/p95 de
   latence, tokens consommés, crédits/coût, nombre de timeouts **payés**
   (pas seulement rapportés — vérifier que le compteur mesure l'appel réel,
   pas un raccourci qui sous-compte), et un score de qualité sourcé.
6. **Résultat = frontière de Pareto, pas un vainqueur.** Rapporter les
   candidats non dominés (aucun autre n'est meilleur sur toutes les
   dimensions) plutôt qu'un seul "gagnant" qui cache un compromis.

## Scripts existants (ne pas réinventer)

- `npm run bench:freeze` — geler le corpus.
- `npm run bench:llm` — exécuter le benchmark LLM.
- `npm run bench:report` — synthèse à partir de la base, pas de la mémoire.
- `npm run discovery:benchmark`, `search:benchmark`, `places:benchmark`,
  `webintel:benchmark` — benchmarks par rail.
- `npm run models:probe` — sonder la disponibilité/latence d'un modèle avant
  de l'inclure dans un run.

## Sortie volumineuse

Ces commandes peuvent produire beaucoup de sortie brute. Rediriger vers un
fichier (`> var/bench-xxx.log`) et lire le résumé produit par `bench:report`
plutôt que de laisser la sortie brute remplir la conversation. Pour un run
long et exploratoire dont on ne veut pas polluer le contexte principal,
lancer la commande dans un sous-agent dédié (`context: fork` sur une
invocation ponctuelle, ou l'agent `Explore`) plutôt que de créer un agent de
projet permanent pour ça.

## Pour aller plus loin, la documentation d’installation,
  la documentation d’installation, la documentation d’installation — exemples
  de rapports par round, avec leurs chiffres et leurs limites dites
  franchement. §"Sous-agents" — le rapport de gate documente aussi la
  politique de sous-agents suivie pendant le round ; garder le même réflexe
  ici (0 par défaut).
