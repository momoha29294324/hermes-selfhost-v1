import { z } from 'zod';

/**
 * R7.3C §11–§15, §34 — ce qu'une observation Instagram A LE DROIT de dire.
 *
 * ---------------------------------------------------------------------------
 * Trois distinctions que ce module existe pour tenir
 * ---------------------------------------------------------------------------
 *   UNREADABLE ≠ ABSENT     le DOM n'a pas rendu la bio ⇒ on ne sait pas si
 *                           elle existe. Ce n'est pas « pas de bio ».
 *   PRIVATE    ≠ INACTIVE   un compte privé publie peut-être tous les jours.
 *                           Nous ne le voyons pas ; c'est tout ce qu'on sait.
 *   NOT_FOUND  ≠ BAD_PROSPECT   un handle qui ne résout pas dit quelque chose
 *                           sur NOTRE donnée, pas sur l'entreprise.
 *
 * Ces trois lignes sont la raison d'être du round : R7.3B a rendu
 * `Instagram UNKNOWN = 286/286`, et un `UNKNOWN` honnête vaut mieux qu'un zéro
 * inventé. Rien ici ne doit rendre plus facile d'écrire un zéro.
 *
 * ---------------------------------------------------------------------------
 * Chaque valeur porte sa provenance
 * ---------------------------------------------------------------------------
 * Un nombre nu est une affirmation sans auteur. `ObservedValue` attache à chaque
 * fait : quand il a été vu, PAR QUEL chemin (réponse réseau déjà chargée, DOM,
 * données structurées), et avec quelle confiance. C'est le §2 de CLAUDE.md
 * appliqué à une source de plus — une observation Instagram est une preuve, avec
 * fournisseur et source, ou elle n'est rien.
 */

/** Les dix seuls états qu'une tentative d'observation peut porter (§11). */
export const OBSERVATION_STATES = [
  'OBSERVED',
  'PARTIAL',
  'PRIVATE',
  'NOT_FOUND',
  'LOGIN_REQUIRED',
  'CHALLENGE',
  'RATE_LIMITED',
  'SESSION_BLOCKED',
  'IDENTITY_CONTRADICTION',
  'UNREADABLE',
] as const;

export type ObservationState = (typeof OBSERVATION_STATES)[number];

/**
 * Les états qui ARRÊTENT la collecte pour tout le monde, pas seulement pour ce
 * profil (§30).
 *
 * Continuer sur les trente-neuf profils suivants après un challenge, c'est
 * demander un blocage de compte en insistant. La liste est courte et fermée :
 * un compte privé ou introuvable n'arrête rien, il est simplement rendu tel quel.
 */
export const GLOBAL_STOP_STATES: readonly ObservationState[] = ['CHALLENGE', 'RATE_LIMITED', 'SESSION_BLOCKED'];

/** Les états sur lesquels une reprise est autorisée (§31). Vide de tout jugement. */
export const TRANSIENT_STATES: readonly ObservationState[] = ['UNREADABLE'];

/** Par quel chemin un fait a été vu. Fermé — un chemin non listé n'existe pas. */
export const OBSERVATION_METHODS = [
  /** Réponse réseau déjà émise par la page pendant son propre chargement. */
  'network_response',
  /** Données structurées présentes dans le document (JSON-LD, méta). */
  'structured_data',
  /** Texte rendu, lu dans le DOM. */
  'dom_text',
  /** Attribut d'un élément du DOM (lien, `datetime`, `title`). */
  'dom_attribute',
] as const;

export type ObservationMethod = (typeof OBSERVATION_METHODS)[number];

export type ObservationConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * Un fait observé, et de quoi le contester.
 *
 * `source` nomme d'où vient la valeur au sens du §2 de CLAUDE.md (l'URL ou le
 * point d'entrée), `method` dit COMMENT elle a été lue. Les deux, parce qu'un
 * même point d'entrée peut être lu de deux façons dont l'une est fiable.
 */
export interface ObservedValue<T> {
  readonly value: T;
  readonly observedAt: string;
  readonly source: string;
  readonly method: ObservationMethod;
  readonly confidence: ObservationConfidence;
}

const observedValue = <T extends z.ZodTypeAny>(inner: T) =>
  z.object({
    value: inner,
    observedAt: z.string().min(1),
    source: z.string().min(1),
    method: z.enum(OBSERVATION_METHODS),
    confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  });

/**
 * Une publication vue depuis le profil — l'essentiel, jamais le contenu (§14).
 *
 * On ne collecte pas la légende ni l'image : la cadence se calcule sur des
 * horodatages, et lire moins est ici la même chose que risquer moins.
 */
export const observedPostSchema = z.object({
  /** Identifiant média quand la réponse réseau le porte. `null` sinon. */
  mediaId: z.string().min(1).nullable(),
  /** Permalien ou clé stable — de quoi dédupliquer sans rien rouvrir. */
  permalink: z.string().min(1).nullable(),
  /** Horodatage RÉELLEMENT observé. Jamais dérivé, jamais estimé. */
  takenAt: z.string().min(1).nullable(),
  mediaType: z.string().min(1).nullable(),
  /** Épinglée : exclue du calcul de cadence, parce qu'elle ment sur la récence. */
  pinned: z.boolean(),
  /**
   * R7.3D — le compte qui a PUBLIÉ cette publication, tel que la charge utile le
   * nomme. `null` quand la charge utile ne le dit pas.
   *
   * Ce champ existe à cause d'un fait observé, pas d'une précaution théorique :
   * la réponse authentifiée du fil d'un profil contient des publications qui ne
   * sont PAS de ce profil. Instagram y injecte des comptes suggérés. Sur le
   * premier profil réellement observé sous session, la publication la plus
   * RÉCENTE de la charge utile appartenait à une autre entreprise — la retenir
   * aurait donné au prospect un `last_post_at` qui n'est pas le sien, c'est-à-dire
   * exactement l'affirmation inventée que le §2 de CLAUDE.md interdit.
   *
   * On ne peut pas s'en remettre à l'enveloppe : la même connexion mélange les
   * deux. Chaque publication porte donc son propriétaire, et le rail écarte
   * celles qui ne sont pas du compte observé — en le COMPTANT, jamais en silence.
   */
  owner: z.string().min(1).nullable().default(null),
});

export type ObservedPost = z.infer<typeof observedPostSchema>;

/**
 * Les faits d'un profil (§12, §17, §18).
 *
 * Tout est optionnel, et l'absence d'une clé signifie « jamais lu ». Aucun champ
 * n'a de valeur par défaut : un `0` écrit ici serait une affirmation, et il n'y
 * en a pas de plus coûteuse que « ce compte n'a rien publié ».
 */
export const profileFactsSchema = z.object({
  username: observedValue(z.string().min(1)).optional(),
  displayName: observedValue(z.string()).optional(),
  biography: observedValue(z.string()).optional(),
  externalWebsite: observedValue(z.string()).optional(),
  category: observedValue(z.string()).optional(),
  verified: observedValue(z.boolean()).optional(),
  isPrivate: observedValue(z.boolean()).optional(),
  postCount: observedValue(z.number().int().min(0)).optional(),
  followersCount: observedValue(z.number().int().min(0)).optional(),
  followingCount: observedValue(z.number().int().min(0)).optional(),
  /**
   * §18 — la PRÉSENCE de stories à la une, jamais leur contenu.
   *
   * Absent quand le DOM ne permet pas de trancher sans ouvrir une story :
   * `highlightsPresent` non renseigné vaut `UNKNOWN`, et c'est la réponse
   * attendue plutôt qu'un `false` qu'aucun regard n'a soutenu.
   */
  highlightsPresent: observedValue(z.boolean()).optional(),
  highlightsCount: observedValue(z.number().int().min(0)).optional(),
  highlightLabels: observedValue(z.array(z.string())).optional(),
  /** Un bouton de contact affiché par le profil (« Contacter », « E-mail »…). */
  contactCtaPresent: observedValue(z.boolean()).optional(),
});

export type ProfileFacts = z.infer<typeof profileFactsSchema>;

/**
 * Le verdict d'identité (§10), séparé des faits parce qu'il les conditionne.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi quatre valeurs et non trois
 * ---------------------------------------------------------------------------
 * La première collecte réelle a produit un cas que trois valeurs ne savaient pas
 * dire. Un prospect dont le site est bâti sur Wix portait, comme preuve
 * `instagram_handle` de fournisseur `website`, le compte Instagram de Wix
 * lui-même — récupéré dans le pied de page du gabarit. Le rail a ouvert
 * exactement le compte demandé, le nom d'utilisateur correspondait au handle
 * attendu, et le profil observé était celui d'un éditeur de logiciel américain.
 *
 * `MATCH` était donc VRAI et trompeur à la fois : il répond à « avons-nous
 * ouvert le compte visé ? », pas à « ce compte est-il celui du prospect ? ».
 * Les deux questions sont distinctes dès que la donnée d'entrée peut être
 * fausse — c'est-à-dire toujours.
 *
 * `UNCORROBORATED` sépare les deux sans rien affirmer de faux : le compte est
 * bien celui qu'on visait, et RIEN dans ce qu'il affiche ne le rattache à cette
 * entreprise. Ce n'est pas une contradiction — nous n'avons pas prouvé qu'il
 * appartient à quelqu'un d'autre — mais ce n'est pas une corroboration, et le
 * §42 exige une corroboration pour débloquer un canal.
 */
export const IDENTITY_VERDICTS = ['MATCH', 'UNCORROBORATED', 'CONTRADICTION', 'UNREADABLE'] as const;
export type IdentityVerdict = (typeof IDENTITY_VERDICTS)[number];

export const identityCheckSchema = z.object({
  expectedHandle: z.string().min(1),
  observedUsername: z.string().nullable(),
  verdict: z.enum(IDENTITY_VERDICTS),
  reason: z.string().min(1),
  /** Les preuves déjà en base qui corroborent le handle. Jamais recalculées ici. */
  corroboration: z.array(z.string()),
});

export type IdentityCheck = z.infer<typeof identityCheckSchema>;

export const screenshotRefSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().length(64),
  viewportWidth: z.number().int().min(1),
  viewportHeight: z.number().int().min(1),
  observedAt: z.string().min(1),
  username: z.string().min(1),
  /**
   * La bannière de consentement a-t-elle été masquée LOCALEMENT pour la photo ?
   *
   * Écrit dans l'artefact plutôt que tu : une revue visuelle doit savoir que
   * l'image a été cosmétiquement ajustée, sans quoi elle jugerait une mise en
   * page qu'aucun visiteur ne voit exactement ainsi.
   */
  overlayHidden: z.boolean().default(false),
});

export type ScreenshotRef = z.infer<typeof screenshotRefSchema>;

/**
 * Une tentative d'observation, telle qu'elle est écrite dans `observations.jsonl`.
 *
 * Une LIGNE PAR TENTATIVE, y compris les échecs : un `NOT_FOUND` est une
 * observation, et une collecte qui n'écrirait que ses succès laisserait croire
 * que les autres n'ont jamais été tentés.
 */
export const profileObservationSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  prospectId: z.string().min(1),
  prospectName: z.string().min(1),
  expectedHandle: z.string().min(1),
  state: z.enum(OBSERVATION_STATES),
  stateDetail: z.string().min(1),
  observedAt: z.string().min(1),
  identity: identityCheckSchema,
  facts: profileFactsSchema,
  posts: z.array(observedPostSchema),
  /** D'où viennent les publications — utile pour juger l'échantillon. */
  postsSource: z.enum(['network_response', 'structured_data', 'dom_attribute', 'none']),
  screenshot: screenshotRefSchema.nullable(),
  /** Refus de la garde réseau pendant cette observation. Sans corps ni jeton. */
  blockedRequests: z.array(z.object({ rule: z.string(), path: z.string(), method: z.string() })),
  /**
   * R7.3D — publications écartées parce qu'elles appartiennent à un AUTRE compte.
   *
   * Publié plutôt que tu : un échantillon filtré sans compteur ne se distingue
   * pas d'un échantillon jamais pollué, et les deux ne se relisent pas de la
   * même façon. Voir `observedPostSchema.owner`.
   */
  postsRejectedForeignOwner: z.number().int().min(0).default(0),
  durationMs: z.number().int().min(0),
});

export type ProfileObservation = z.infer<typeof profileObservationSchema>;

/**
 * §46 — le fait qui rend la garantie vérifiable plutôt qu'affirmée.
 *
 * Le rail ne doit JAMAIS dépendre d'une mutation pour réussir : une observation
 * en `OBSERVED` alors que des écritures ont été refusées prouve exactement ça.
 * On compte donc les refus, on ne les cache pas — et le compteur d'écritures
 * RÉUSSIES reste structurellement à zéro, puisqu'aucune n'est autorisée à sortir.
 */
export function countBlockedByRule(observations: readonly ProfileObservation[]): Map<string, number> {
  const tally = new Map<string, number>();
  for (const observation of observations) {
    for (const blocked of observation.blockedRequests) {
      tally.set(blocked.rule, (tally.get(blocked.rule) ?? 0) + 1);
    }
  }
  return tally;
}

// ---------------------------------------------------------------------------
// §15 — `last_post_at`
// ---------------------------------------------------------------------------

/**
 * La date de la dernière publication, dérivée d'un horodatage RÉELLEMENT observé
 * ou de rien du tout.
 *
 * L'interdiction que cette fonction incarne : `post_count` élevé n'implique pas
 * `last_post_at` récent. Un compte à 889 publications peut être muet depuis deux
 * ans, et c'est précisément le cas qui change une décision commerciale.
 *
 * Les publications épinglées sont ÉCARTÉES. Instagram les affiche en tête de
 * grille quel que soit leur âge : les retenir ferait passer un compte dormant
 * pour un compte vivant dès que son autrice a épinglé un post récent — ou
 * l'inverse, un compte actif pour un compte mort quand l'épingle est vieille.
 */
export function deriveLastPostAt(posts: readonly ObservedPost[]): Date | null {
  const dates = posts
    .filter((post) => !post.pinned)
    .map((post) => (post.takenAt === null ? null : new Date(post.takenAt)))
    .filter((date): date is Date => date !== null && Number.isFinite(date.getTime()));
  if (dates.length === 0) return null;
  return dates.reduce((latest, current) => (current.getTime() > latest.getTime() ? current : latest));
}

// ---------------------------------------------------------------------------
// §34 — fraîcheur
// ---------------------------------------------------------------------------

export const FRESHNESS_LEVELS = ['FRESH', 'AGING', 'STALE', 'UNKNOWN'] as const;
export type Freshness = (typeof FRESHNESS_LEVELS)[number];

/** Seuils explicites, en jours. Une observation vieille ne devient pas vraie. */
export const FRESHNESS_THRESHOLDS = { freshDays: 14, agingDays: 60 } as const;

export function classifyFreshness(observedAt: string | null, now: Date): Freshness {
  if (observedAt === null) return 'UNKNOWN';
  const at = new Date(observedAt);
  if (!Number.isFinite(at.getTime())) return 'UNKNOWN';
  const days = (now.getTime() - at.getTime()) / 86_400_000;
  if (days < 0) return 'UNKNOWN';
  if (days <= FRESHNESS_THRESHOLDS.freshDays) return 'FRESH';
  if (days <= FRESHNESS_THRESHOLDS.agingDays) return 'AGING';
  return 'STALE';
}
