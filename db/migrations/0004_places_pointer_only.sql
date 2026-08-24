-- 0004_places_pointer_only.sql — corrige 0003 après lecture des conditions Google.
--
-- 0003 créait `google_places_cache (place_id, payload jsonb, expires_at)`, pensée
-- comme un cache de contenu Places sous TTL. La documentation officielle, lue
-- ensuite, ne laisse pas cette porte ouverte :
--
--   - ToS §3.2.3(a)(iii) interdit nommément de « copy and save business names,
--     addresses, or user reviews » ;
--   - seul le `place_id` est exempté des restrictions de cache, sans limite ;
--   - seules les valeurs lat/lng disposent d'un délai — 30 jours glissants,
--     après quoi la suppression est obligatoire ;
--   - tous les autres champs (nom, adresse, téléphone, site, note, horaires)
--     n'ont AUCUNE permission de cache. Leur TTL n'est pas long, il est nul.
--
-- Une table à payload générique ne peut donc pas être rendue conforme par un
-- TTL : ce n'est pas la durée qui pose problème, c'est le contenu. Elle part.
--
-- Ce qui la remplace ne contient aucune donnée Google en dehors de
-- l'identifiant lui-même et d'une position géographique sous bail.

drop table if exists google_places_cache;

create table google_place_candidates (
  -- Le seul champ Places conservable indéfiniment (exemption explicite).
  place_id            text primary key,
  campaign_id         uuid not null references campaigns(id) on delete cascade,

  -- Position sous bail de 30 jours. `location_expires_at` n'est pas un confort
  -- de cache : c'est l'échéance après laquelle ces deux colonnes doivent être
  -- remises à null (purgePlaceLocations, appelée à chaque run).
  latitude            double precision,
  longitude           double precision,
  location_expires_at timestamptz,

  -- Notre propre jugement sur le candidat — pas du contenu Google.
  -- discovered   : id ramassé par la recherche, rien d'autre demandé
  -- in_area      : la position tombe dans la géographie de la campagne
  -- qualified    : le pré-filtre niche le retient
  -- identified   : une source INDÉPENDANTE a fourni une identité → prospect
  -- unidentified : retenu, mais ni le site ni le registre n'ont pu l'identifier
  -- rejected     : écarté ; `reject_reason` dit à quel étage et pourquoi
  status              text not null default 'discovered'
                        check (status in ('discovered', 'in_area', 'qualified',
                                          'identified', 'unidentified', 'rejected')),
  reject_reason       text,

  -- Paliers de SKU déjà payés pour ce place_id, pour qu'un second run ne
  -- repaie pas ce qu'il sait déjà. Contient des noms de paliers, jamais de
  -- valeurs de champs.
  tiers_fetched       jsonb not null default '[]'::jsonb,

  prospect_id         uuid references prospects(id) on delete set null,

  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now()
);

create index google_place_candidates_campaign_idx
  on google_place_candidates (campaign_id, status);
create index google_place_candidates_location_expiry_idx
  on google_place_candidates (location_expires_at)
  where location_expires_at is not null;

-- Les colonnes note/avis de `prospects` restent en place : une entreprise peut
-- publier son propre nombre d'avis sur son site, et cette observation-là nous
-- appartient. Ce qui change, c'est qu'aucune valeur Places n'y entre jamais.
comment on column prospects.google_rating is
  'Note publique observée. Ne doit JAMAIS recevoir une valeur issue de Places (contenu non conservable).';
comment on column prospects.google_review_count is
  'Nombre d''avis publics observé. Ne doit JAMAIS recevoir une valeur issue de Places (contenu non conservable).';
