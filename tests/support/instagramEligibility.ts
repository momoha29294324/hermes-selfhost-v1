import type { Sql } from '@/lib/db/sql';

/**
 * De quoi fabriquer un prospect qui passe RÉELLEMENT les portes d'éligibilité,
 * plutôt qu'un prospect qu'on aurait dispensé de les franchir.
 *
 * Ce module NE CONTOURNE RIEN : il ajoute au prospect ce qui lui manquait —
 *
 *   * du contenu d'entreprise LU (`website_headings`, `website_text`), sans
 *     quoi le gate ICP rend `REVIEW_REQUIRED` avec le motif « aucun contenu
 *     d'entreprise n'a été lu ». Et il a raison de le rendre : on ne déclare
 *     pas éligible ce qu'on n'a pas ouvert ;
 *   * une identité `confirmed`, sans quoi le compte visé n'est qu'un compte
 *     ressemblant ;
 *   * une ANCRE DE MARCHÉ observée. La politique autonome exige qu'un fait
 *     place l'entreprise sur un marché, parce que `prospects.country` est une
 *     constante de découverte et non une observation. Un code postal en est
 *     un, et c'est le plus neutre des trois : contrairement au domaine et au
 *     numéro de registre, il n'est pas une clé d'identité, donc l'ajouter ne
 *     fabrique aucun doublon entre fixtures.
 *
 * Les écritures passent par les mêmes tables que la production
 * (`prospect_evidence`, `prospects`), avec fournisseur, méthode et URL source —
 * pas par un drapeau de test.
 *
 * Le contenu ci-dessous est SYNTHÉTIQUE et volontairement neutre : il parle le
 * vocabulaire de `config/niches/example-services.json`, qui ne décrit aucun
 * marché réel. Un test qui a besoin d'un autre métier fournit son propre
 * contenu plutôt que de changer celui-ci.
 */

/** Un contenu de site anodin : aucun marqueur de franchise, de réseau ni de multi-sites. */
const INDEPENDENT_HEADINGS = 'Prestation standard sur rendez-vous — un atelier indépendant';
const INDEPENDENT_TEXT =
  'Notre atelier assure une prestation standard et une intervention sur site pour les ' +
  'professionnels de la région. Nous travaillons dans un rayon de vingt kilomètres, ' +
  "avec une équipe de deux personnes.";

/**
 * Rend un prospect éligible : contenu lu + identité confirmée.
 *
 * À appeler AVANT `lockManifestForItem` — le manifeste fige `identity_review` au
 * moment du verrouillage, et le gate ICP du lock lit les preuves à cet instant.
 */
export async function makeProspectInstagramEligible(
  sql: Sql,
  prospectId: string,
  options: { sourceUrl?: string } = {},
): Promise<void> {
  await giveProspectIndependentWebsiteContent(sql, prospectId, options);
  await sql.query(
    `update prospects set identity_review = 'confirmed',
            postal_code = coalesce(postal_code, '37000')
      where id = $1`,
    [prospectId],
  );
  await sql.query(
    `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
     values ($1,'postal_code','37000','website','crawl',$2,1.0)`,
    [prospectId, options.sourceUrl ?? 'https://example.com'],
  );
}

/**
 * La moitié « contenu lu » de la fixture ci-dessus, SANS la confirmation
 * d'identité.
 *
 * C'est l'état d'un prospect dont le site a été crawlé et dont l'ICP a conclu
 * `GOOD_ICP`, mais dont `identity_review` est resté `manual_review` faute de
 * rapprochement avec un registre légal. C'est exactement le prospect sur lequel
 * une confirmation humaine de canal a un sens, et un test qui partirait d'une
 * identité déjà `confirmed` ne prouverait rien de ce chemin-là.
 */
export async function giveProspectIndependentWebsiteContent(
  sql: Sql,
  prospectId: string,
  options: { sourceUrl?: string } = {},
): Promise<void> {
  const sourceUrl = options.sourceUrl ?? 'https://example.com';

  await sql.query(
    `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
     values ($1,'website_headings',$2,'website','crawl',$3,1.0),
            ($1,'website_text',    $4,'website','crawl',$3,1.0)`,
    [prospectId, INDEPENDENT_HEADINGS, sourceUrl, INDEPENDENT_TEXT],
  );
}

/**
 * L'inverse, pour les tests qui doivent prouver qu'une porte REFUSE : du contenu
 * lu, et un recrutement de franchisés dedans.
 */
export async function makeProspectFranchise(sql: Sql, prospectId: string): Promise<void> {
  await sql.query(
    `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
     values ($1,'website_headings',$2,'website','crawl','https://exemple-reseau.fr',1.0)`,
    [prospectId, 'Devenez franchisé et rejoignez notre réseau national'],
  );
}
