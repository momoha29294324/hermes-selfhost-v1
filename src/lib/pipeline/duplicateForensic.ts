/**
 * R7.2 §9 — trouver les doublons, et ne rien y toucher.
 *
 * ---------------------------------------------------------------------------
 * Le cas qui l'a motivé
 * ---------------------------------------------------------------------------
 * Le corpus contient deux lignes pour la même entreprise lyonnaise : même
 * domaine, même compte Instagram, même SIREN, même email, même téléphone — et
 * `dedupe_status = 'unique'` sur les deux. Ce n'était pas une faiblesse de la
 * comparaison de noms : `normalizeName` gère très bien « Kapital Car'e » contre
 * « KAPITALCAR'E ». La cause est ailleurs, et elle est structurelle.
 *
 * Toutes les recherches d'identité de `ProspectRepository` sont bornées à une
 * campagne (`where campaign_id = $1`, `src/lib/repo/prospects.ts`), l'index
 * l'est aussi (`prospect_identities_lookup_idx (campaign_id, kind, value)`), et
 * la seule contrainte d'unicité est `(campaign_id, canonical_key)`. Deux rails
 * qui lisent la même page web dans deux campagnes différentes ne peuvent donc
 * pas se voir. Le moteur de déduplication n'a pas échoué — on ne lui a jamais
 * montré les deux lignes.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module fait, et ce qu'il ne fera jamais
 * ---------------------------------------------------------------------------
 * Il GROUPE et il PROPOSE. Il ne fusionne pas, ne supprime pas, n'écrit pas,
 * ne prend aucune connexion : c'est une fonction pure sur des lignes déjà lues.
 * La correction de la déduplication est une autre mission, et elle demande des
 * arbitrages qu'un regroupement ne peut pas rendre — laquelle des deux adresses
 * est la bonne quand le registre et le site ne disent pas la même chose, que
 * faire d'un manifeste verrouillé porté par la ligne perdante.
 *
 * Ne cherche PAS non plus à décider seul : une entreprise dont le seul point
 * commun avec une autre est un nom de métier générique (« PRESTATION STANDARD
 * AUTOMOBILE ») n'est pas un doublon, et le corpus en contient plusieurs.
 * D'où la distinction entre `STRONG` et `PROBABLE`, et le refus d'émettre une
 * clé de nom sans localité.
 */

export type DuplicateKey = 'domain' | 'instagram' | 'registry_id' | 'email' | 'phone' | 'name_locality';

export const DUPLICATE_KEYS: readonly DuplicateKey[] = [
  'domain',
  'instagram',
  'registry_id',
  'email',
  'phone',
  'name_locality',
];

export interface DuplicateRow {
  readonly id: string;
  readonly displayName: string;
  readonly campaignSlug: string | null;
  readonly city: string | null;
  readonly postalCode: string | null;
  readonly domain: string | null;
  readonly websiteUrl: string | null;
  readonly instagramHandle: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly registryId: string | null;
  readonly score: number | null;
  readonly stage: string | null;
  readonly evidenceCount: number;
  readonly createdAt: string | null;
}

export type ClusterStrength = 'STRONG' | 'PROBABLE';

export interface DuplicateCluster {
  readonly clusterId: string;
  readonly keysMatched: readonly DuplicateKey[];
  readonly strength: ClusterStrength;
  readonly rows: readonly DuplicateRow[];
  readonly canonicalCandidateId: string;
  readonly reason: string;
  /** Vrai quand toutes les lignes ne sont pas dans la même campagne — la signature du défaut. */
  readonly crossCampaign: boolean;
}

// ---------------------------------------------------------------------------
// Normalisation — la même discipline que `src/lib/identity/normalize.ts`,
// appliquée aux seules clés dont ce module a besoin.
// ---------------------------------------------------------------------------

const ACCENTS = 'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ';
const PLAIN = 'aaaaaaceeeeiiiinooooouuuuyy';

function stripAccents(value: string): string {
  let output = '';
  for (const character of value) {
    const index = ACCENTS.indexOf(character);
    output += index >= 0 ? PLAIN[index] : character;
  }
  return output;
}

export function normalizeDomainKey(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeHandleKey(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim().toLowerCase().replace(/^@/, '');
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeEmailKey(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.includes('@') ? trimmed : null;
}

/**
 * Téléphone réduit à ses chiffres, indicatif français normalisé.
 *
 * `+33478000000` et `0478000000` sont le même numéro, et un doublon qui se
 * cacherait derrière une différence de format n'aurait aucun intérêt.
 */
export function normalizePhoneKey(value: string | null): string | null {
  if (value === null) return null;
  let digits = value.replace(/\D/g, '');
  if (digits.startsWith('33') && digits.length === 11) digits = `0${digits.slice(2)}`;
  return digits.length >= 9 ? digits : null;
}

export function normalizeRegistryKey(value: string | null): string | null {
  if (value === null) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 9 ? digits : null;
}

export function normalizeNameKey(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = stripAccents(value.toLowerCase()).replace(/[^a-z0-9]/g, '');
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Le nom SEUL n'est jamais une clé.
 *
 * « SERVICES DEMO », « DEMO SERVICES », « DEMO SERVICE » sont
 * des noms de métier que plusieurs entreprises portent réellement, dans des
 * communes différentes et avec des SIREN différents. Les grouper sur le nom
 * produirait des faux positifs que personne ne pourrait démêler — et la
 * conséquence d'une fusion à tort est bien pire que celle d'un doublon laissé
 * en place. La clé exige donc une localité, et rend `null` sans elle.
 */
export function nameLocalityKey(row: DuplicateRow): string | null {
  const name = normalizeNameKey(row.displayName);
  if (name === null) return null;
  const locality = row.postalCode?.trim() ?? row.city?.trim() ?? null;
  const normalizedLocality = locality === null ? null : normalizeNameKey(locality);
  if (normalizedLocality === null) return null;
  return `${name}|${normalizedLocality}`;
}

export function keyValue(row: DuplicateRow, key: DuplicateKey): string | null {
  switch (key) {
    case 'domain':
      return normalizeDomainKey(row.domain ?? row.websiteUrl);
    case 'instagram':
      return normalizeHandleKey(row.instagramHandle);
    case 'registry_id':
      return normalizeRegistryKey(row.registryId);
    case 'email':
      return normalizeEmailKey(row.email);
    case 'phone':
      return normalizePhoneKey(row.phone);
    case 'name_locality':
      return nameLocalityKey(row);
  }
}

// ---------------------------------------------------------------------------
// Regroupement
// ---------------------------------------------------------------------------

class UnionFind {
  private readonly parent = new Map<string, string>();

  find(id: string): string {
    const parent = this.parent.get(id);
    if (parent === undefined) {
      this.parent.set(id, id);
      return id;
    }
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    // Racine déterministe : le plus petit identifiant gagne, toujours.
    if (rootA < rootB) this.parent.set(rootB, rootA);
    else this.parent.set(rootA, rootB);
  }
}

function filledFields(row: DuplicateRow): number {
  return [row.domain, row.instagramHandle, row.email, row.phone, row.registryId, row.city, row.postalCode].filter(
    (value) => value !== null && value !== '',
  ).length;
}

/**
 * Le candidat canonique — une PROPOSITION, sur des faits observables seulement.
 *
 * Le nombre de preuves d'abord : c'est la ligne qui a été le plus travaillée,
 * et la perdre coûterait le plus. Puis la complétude, puis le score. À égalité
 * parfaite, l'identifiant tranche, pour que deux exécutions donnent le même
 * candidat — un rapport qui changerait d'avis d'une fois sur l'autre ne serait
 * pas un rapport.
 */
function canonicalCandidate(rows: readonly DuplicateRow[]): DuplicateRow {
  const sorted = [...rows].sort((a, b) => {
    const byEvidence = b.evidenceCount - a.evidenceCount;
    if (byEvidence !== 0) return byEvidence;
    const byFilled = filledFields(b) - filledFields(a);
    if (byFilled !== 0) return byFilled;
    const byScore = (b.score ?? -1) - (a.score ?? -1);
    if (byScore !== 0) return byScore;
    return a.id.localeCompare(b.id);
  });
  const first = sorted[0];
  if (first === undefined) throw new Error('cluster vide — impossible');
  return first;
}

/**
 * Les grappes de doublons, par accord de clés indépendantes.
 *
 * `STRONG` demande DEUX clés indépendantes ou plus. Une seule ne suffit pas :
 * un domaine partagé peut être une page d'agence, un téléphone partagé peut
 * être un centre d'appel, et un nom+code postal partagé peut être une homonymie
 * de quartier. Deux clés qui concordent sur des dimensions différentes, en
 * revanche, ne se produisent pas par hasard.
 */
export function findDuplicateClusters(rows: readonly DuplicateRow[]): DuplicateCluster[] {
  const union = new UnionFind();
  /** Pour chaque clé, la valeur → les lignes qui la portent. */
  const buckets = new Map<DuplicateKey, Map<string, string[]>>();

  for (const key of DUPLICATE_KEYS) {
    const byValue = new Map<string, string[]>();
    for (const row of rows) {
      const value = keyValue(row, key);
      if (value === null) continue;
      const list = byValue.get(value) ?? [];
      list.push(row.id);
      byValue.set(value, list);
    }
    buckets.set(key, byValue);
    for (const ids of byValue.values()) {
      if (ids.length < 2) continue;
      const [first] = ids;
      if (first === undefined) continue;
      for (const id of ids.slice(1)) union.union(first, id);
    }
  }

  const byRoot = new Map<string, DuplicateRow[]>();
  for (const row of rows) {
    const root = union.find(row.id);
    const list = byRoot.get(root) ?? [];
    list.push(row);
    byRoot.set(root, list);
  }

  const clusters: DuplicateCluster[] = [];
  for (const [root, members] of byRoot) {
    if (members.length < 2) continue;
    const ids = new Set(members.map((row) => row.id));

    const keysMatched = DUPLICATE_KEYS.filter((key) => {
      const byValue = buckets.get(key);
      if (byValue === undefined) return false;
      for (const holders of byValue.values()) {
        const inside = holders.filter((id) => ids.has(id));
        if (inside.length >= 2) return true;
      }
      return false;
    });

    const sortedMembers = [...members].sort((a, b) => a.id.localeCompare(b.id));
    const candidate = canonicalCandidate(sortedMembers);
    const campaigns = new Set(sortedMembers.map((row) => row.campaignSlug ?? '(inconnue)'));
    const others = sortedMembers.filter((row) => row.id !== candidate.id);

    clusters.push({
      clusterId: root,
      keysMatched,
      strength: keysMatched.length >= 2 ? 'STRONG' : 'PROBABLE',
      rows: sortedMembers,
      canonicalCandidateId: candidate.id,
      reason:
        `${keysMatched.length} clé(s) concordante(s) : ${keysMatched.join(', ')}. ` +
        `Candidat canonique « ${candidate.displayName} » — ${candidate.evidenceCount} preuve(s) contre ` +
        `${others.map((row) => row.evidenceCount).join('/')}, ${filledFields(candidate)} champ(s) renseigné(s), ` +
        `score ${candidate.score ?? '—'}. ` +
        (campaigns.size > 1
          ? `Grappe INTER-CAMPAGNE (${[...campaigns].sort().join(' ↔ ')}) : hors de portée de la déduplication actuelle, qui ne cherche qu'à l'intérieur d'une campagne.`
          : 'Grappe intra-campagne : à examiner, la déduplication aurait dû la voir.'),
      crossCampaign: campaigns.size > 1,
    });
  }

  return clusters.sort((a, b) => {
    const byStrength = (b.strength === 'STRONG' ? 1 : 0) - (a.strength === 'STRONG' ? 1 : 0);
    if (byStrength !== 0) return byStrength;
    const byKeys = b.keysMatched.length - a.keysMatched.length;
    if (byKeys !== 0) return byKeys;
    return a.clusterId.localeCompare(b.clusterId);
  });
}

/** Les lignes concernées par une grappe forte, pour un compte de tête. */
export function summariseClusters(clusters: readonly DuplicateCluster[]): {
  strong: number;
  probable: number;
  rowsInvolved: number;
  crossCampaign: number;
} {
  const strong = clusters.filter((cluster) => cluster.strength === 'STRONG');
  return {
    strong: strong.length,
    probable: clusters.length - strong.length,
    rowsInvolved: clusters.reduce((total, cluster) => total + cluster.rows.length, 0),
    crossCampaign: clusters.filter((cluster) => cluster.crossCampaign).length,
  };
}
