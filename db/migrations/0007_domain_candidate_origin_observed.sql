-- 0007_domain_candidate_origin_observed.sql — corrige 0006 après le premier
-- passage à blanc du rail.
--
-- 0006 énumérait l'origine d'un domaine candidat par la source qui l'avait
-- proposé : `common_crawl`, `searx`, `website`, `registry`, `social`, `manual`,
-- plus `generated` pour ceux que nous fabriquons.
--
-- Le rail, lui, ne fait pas cette distinction, et il a raison de ne pas la
-- faire. Ce qui change la façon de juger un candidat n'est pas QUEL moteur l'a
-- proposé, c'est s'il a été **observé quelque part** ou **fabriqué par nous** :
--   - un domaine observé peut servir d'indice sur le nom (quelqu'un l'a vu
--     associé à cette entreprise) ;
--   - un domaine fabriqué à partir du nom du prospect ne le peut pas, sous
--     peine de raisonnement circulaire — c'est `domainOrigin` dans
--     `identityVerify.ts`, et un test le fige.
--
-- La contrainte reçoit donc `observed`. Les valeurs par source restent
-- acceptées : elles redeviendront utiles le jour où l'on voudra attribuer un
-- rattachement au moteur précis qui a soufflé le domaine.

alter table discovery_domain_candidates
  drop constraint if exists discovery_domain_candidates_origin_check;

alter table discovery_domain_candidates
  add constraint discovery_domain_candidates_origin_check
  check (origin in ('generated', 'observed', 'common_crawl', 'searx',
                    'website', 'registry', 'social', 'manual'));

comment on column discovery_domain_candidates.origin is
  'generated = fabriqué à partir du nom du prospect (jamais un indice sur le nom) ; '
  'observed = vu ailleurs (site, réseau social, moteur) ; les autres valeurs nomment la source précise.';
