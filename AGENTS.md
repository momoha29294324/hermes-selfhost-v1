# Règles de travail dans ce dépôt

Ce fichier s'applique à tout agent (Claude, Codex, …) et à tout humain qui
modifie ce projet.

Si vous **installez** Hermes plutôt que de le modifier, lisez `CLAUDE_SETUP.md`.
Ce fichier-ci décrit comment on écrit du code ici.

## Interdits absolus

1. **Ne rien envoyer par défaut.** Pas de message privé, pas d'email, pas de
   SMS, pas de relance, pas de réponse à un prospect, pas de lead CRM. L'arrêt
   est l'état de repos.

   Trois choses doivent être vraies AVANT qu'un message réel ne parte, et aucune
   n'est acquise par défaut :

   - l'**arrêt global est levé**, par un geste d'opérateur nommé
     (`npm run ig:kill-switch -- --release --as "<nom>" --reason "<motif>"`) ;
   - une **autorisation existe pour ce canal**. Le premier contact et
     l'auto-réponse sont deux autorisations DISTINCTES : l'une n'implique jamais
     l'autre, et recevoir un message n'a jamais suffi à en autoriser un second ;
   - le **crochet pré-effet passe, juste avant l'effet** — pas au début du
     cycle. Un humain qui réarme l'arrêt pendant qu'un navigateur est ouvert
     doit stopper CE message, pas le suivant.

   Un agent ne s'accorde aucune de ces trois choses à lui-même. Elles
   appartiennent à un opérateur humain, nommé, qui en répond.

   **Fail-closed est la règle, pas une précaution.** Un fait manquant, illisible
   ou ambigu REFUSE. Une absence de preuve n'est jamais une preuve d'absence.
   Quand vous ajoutez une porte, la valeur par défaut est le refus.

2. **Ne jamais inventer une donnée.** Toute affirmation sur un prospect doit
   correspondre à une ligne `prospect_evidence` avec son fournisseur et sa
   source. Si ce n'est pas observé, c'est `null` ou `unknowns` — jamais une
   supposition présentée comme un fait, et jamais l'affirmation d'une absence
   non vérifiée.

3. **Aucune preuve chiffrée n'est citable par défaut.** Cette édition ne livre
   AUCUNE performance observée, et `performanceEvidenceDisclosure()` rend
   `WITHHELD_PENDING_PROVENANCE` en littéral de type. Citer un chiffre demande
   une ligne `case_studies` portant sa métrique ET sa source, relue par un
   humain. Un chiffre écrit dans un prompt n'est pas une preuve.

4. **Ce que l'instance vend n'est pas dans le code.** L'offre commerciale vit
   dans `config/offer.json`, qui n'est pas livré. Tant qu'il est absent, toute
   question de prix, de durée, de périmètre ou de garantie ESCALADE vers un
   humain — c'est le défaut voulu. N'écrivez jamais une condition commerciale en
   dur dans `src/` : elle partirait, mot pour mot, à des gens qui ne l'ont
   jamais acceptée.

5. **L'ICP et la verticale non plus.** `config/icp/` et `config/niches/` sont à
   l'opérateur. Les fichiers `example-*` livrés sont SYNTHÉTIQUES : ils ne
   décrivent aucun marché réel et ne sont calibrés sur rien. Ne les présentez
   jamais comme des défauts réglés.

   Cette édition **réserve une famille de verticales**
   (`src/lib/config/verticalPolicy.ts`). La porte est appelée par le chargeur de
   configuration lui-même, pas par l'appelant : ajouter une commande qui charge
   une niche ne peut donc pas oublier de demander l'autorisation. Ne la
   contournez pas, ne l'affaiblissez pas, et ne cherchez pas de formulation
   voisine pour la faire passer.

6. **Pas de contournement de plateforme.** Respecter `robots.txt`, ne pas
   contourner les limites d'un service, ne pas activer silencieusement un accès
   supplémentaire.

7. **Aucun secret** dans Git, dans un log, dans un message ou dans un commit.
   `scripts/check-secrets.sh` avant tout push.

## Conventions techniques

- TypeScript strict partout (`noUncheckedIndexedAccess` inclus). Pas de `any`.
- **Toute logique déterministe reste du CODE testé, jamais un prompt.** Dédup,
  arithmétique du score, garde-fous, portes d'éligibilité : une règle qui décide
  qu'un message part sans relecture humaine ne peut pas dépendre de l'humeur
  d'un modèle. Ce qui DÉCIDE est du code, et il s'exécute APRÈS le modèle.
- Aucun nom de modèle ni niveau d'effort en dur : tout passe par
  `config/models.json` et le `ModelRouter`.
- Aucune géographie ni vocabulaire de niche en dur : `config/campaigns/`,
  `config/niches/`. Le plancher de personnalisation et l'accroche de premier
  contact lisent `serviceTerms` et `coreActivityTerms` de la niche pour savoir
  quels mots ne distinguent RIEN. Sans déclaration, les deux gardes restent
  actives et simplement plus lâches — jamais absentes, et jamais complétées par
  une liste écrite dans `src/`.
- Un accès réseau passe par `HttpClient` (timeout, retries bornés, rate limit,
  robots.txt, cache). Pas de `fetch` nu dans le domaine.
- Une modification de schéma = une **nouvelle** migration dans `db/migrations/`.
  Modifier une migration déjà appliquée est refusé par le runner (checksum), et
  cela vaut pour un COMMENTAIRE : corriger une faute de frappe dans un `--` de
  `0014` casse `npm run db:migrate` chez tous ceux qui l'ont appliquée.
  `tests/migrationChecksums.test.ts` gèle l'empreinte des migrations livrées ;
  quand il échoue, on RESTAURE le fichier, on ne recopie pas l'empreinte.
- Logs : `logger` structuré uniquement (`no-console` est une erreur de lint).
- Un worker `--loop` garde le code de son démarrage. Après un changement de
  version de politique ou de classifieur, **redémarrer les loops est
  obligatoire**.

## Ce qu'on ne desserre pas

Ces invariants sont certifiés et testés. Les modifier demande une décision
humaine explicite, pas une commodité de développement :

```text
auto-réponse à un inconnu            = NON
auto-réponse au retard historique    = NON (frontière d'activation durable)
fail-closed                          = la règle
bail navigateur exclusif             = un propriétaire par rôle
vérification d'identité du fil       = relue sur la page, avant l'effet
crochet pré-effet                    = relu juste avant, deux fois
idempotence                          = un effet tenté n'est JAMAIS rejoué
arrêt global                         = geste humain nommé
plafonds jour / heure, espacement    = partagés, un seul compteur
fenêtre d'envoi                      = un seul ordonnanceur
activation bornée (--max-effects)    = s'arrête d'elle-même
premier contact                      = autorisation SÉPARÉE de l'auto-réponse
                                       (deux tables, deux budgets, deux gestes)
retrait d'une intention              = simulation par défaut, jamais après un effet
double réservation                   = refusée par la BASE, pas par le code
disponibilité non déclarée           = erreur de configuration, jamais « toujours »
migration déjà publiée               = ne se modifie plus, commentaire compris
```

## Avant de livrer

```bash
npm run validate     # typecheck + lint + tests — doit passer
```

Ne jamais annoncer qu'un test passe sans l'avoir exécuté, ni qu'une donnée a été
collectée sans l'avoir vue en base.

## Aller plus loin

Les procédures détaillées vivent dans des Skills chargées à la demande
(`.claude/skills/`) — ne pas les recopier ici :

- `outbound-evidence` — preuve et identité d'un prospect.
- `outbound-benchmark` — protocole de benchmark reproductible.
- `outbound-gate` — validation GO/PARTIAL/FAIL d'un lot de prospects.
- `outbound-release` — checklist avant de livrer ou fusionner.
