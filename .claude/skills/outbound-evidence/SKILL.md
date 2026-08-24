---
name: outbound-evidence
description: >
  Connaissance métier sur la preuve et l'identité d'un prospect Hermes
  Outbound : provenance des données, "non observé" vs "absent", preuve
  faible vs forte, statut d'un fournisseur de recherche comme indice de
  découverte et non comme source, identité légale vs identité sociale,
  preuve de funnel commercial. À utiliser pour toute tâche de qualification,
  recherche (research), scoring, angle ou message d'un prospect.
when_to_use: >
  Qualifier un prospect, écrire ou relire un rail de découverte/enrichissement,
  discuter d'un score, d'un angle commercial ou d'un message, ou juger si une
  affirmation sur une entreprise est fondée. Pas pour du travail d'infra, de
  build, de UI ou de config sans lien avec les données prospects.
---

# Preuve et identité — Hermes

Rappel des invariants (`CLAUDE.md` §2-3, non négociables) :

- Toute affirmation sur un prospect correspond à une ligne `prospect_evidence`
  avec fournisseur et source. Sinon : `null` ou `unknowns` — jamais une
  supposition présentée comme un fait.
- **"Non observé" ≠ "absent".** Ne jamais écrire qu'une entreprise n'a "pas de
  site" ou "pas d'avis" parce qu'un rail donné n'en a pas trouvé — seulement
  qu'aucune source consultée ne le confirme.
- Une seule preuve chiffrée autorisée, mot pour mot : « Nous avons déjà généré
  environ 3 500 € pour un client que nous accompagnons. » Aucun ROAS, lead,
  budget, période, marge ou attribution. Une nouvelle preuve passe d'abord par
  `case_studies` avec ses métriques sourcées — jamais improvisée dans un
  message.

## Lecture d'une source

- **Registre officiel** (SIRENE, etc.) : identité légale, la plus forte —
  nom, forme juridique, adresse, statut d'activité.
- **Site officiel de l'entreprise** : forte pour l'activité et le parcours
  commercial observés directement (tarifs, réservation, CTA). Un compte
  d'éditeur de site (mentions légales du prestataire web) n'est PAS le
  compte de l'entreprise cliente — vérifier à qui appartient le SIREN cité.
- **Provider de recherche (Serper, Brave, Google CSE, Places, webintel)** :
  un **indice de découverte**, jamais une source d'affirmation. Il dit "voici
  une URL/un lieu plausible" ; ce que dit cette URL doit ensuite être lu et
  sourcé séparément. Google Places en particulier : lire
  la documentation d’installation avant toute conservation de champ au-delà
  de `place_id` et coordonnées — la plupart des champs n'ont pas la
  permission d'être stockés.
- **Réseau social** : identité sociale, pas légale. Un profil Instagram/FB
  confirme une présence, pas une entité juridique ; ne pas fusionner avec le
  SIREN sans un lien explicite (site → réseau, ou réseau → site).
- **Common Crawl / index web ouvert** : corrobore qu'un domaine a servi des
  pages ; n'établit jamais qu'un domaine appartient à une entreprise donnée,
  et ne sert jamais à *rejeter* un candidat (l'index échantillonne, il
  n'énumère pas).

## Dédup et fusion

Deux fiches sont la même entreprise seulement si SIREN identique, domaine
identique, ou (nom quasi identique **et** même ville). Ne jamais fusionner sur
la seule ressemblance du nom.

## Funnel commercial (evidence, pas d'invention)

Le score et l'angle se construisent sur ce qui est *observé* du parcours :
tarifs affichés ou non, réservation en ligne réelle ou non, CTA présent,
conversion par téléphone seul. Une absence de tarif observée sur le site est
une evidence positive pour l'angle ("aucun tarif affiché") — ce n'est pas la
même chose que l'absence de site.

## Pour aller plus loin — repondération du score sur le parcours., la documentation d’installation — rails et leurs limites., la documentation d’installation, la documentation d’installation,
  la documentation d’installation — conditions d'usage et garde-fous par fournisseur. — exemple de rapport où ces règles sont appliquées à un
  vrai corpus.
