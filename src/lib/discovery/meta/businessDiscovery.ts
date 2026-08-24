import {
  instagramBusinessDiscoveryAccess,
  MetaAccessBlockedError,
  META_GRAPH_BASE,
  metaCredentials,
  type MetaCredentials,
  type SourceAccessState,
} from '@/lib/discovery/meta/access';
import { classifyGraphError, MetaApiError } from '@/lib/discovery/meta/pagesSearch';
import { normalizeInstagramHandle, normalizeUrl } from '@/lib/identity/normalize';
import type { HttpClient } from '@/lib/http/client';
import type { Logger } from '@/lib/logging/logger';
import type { EvidenceInput } from '@/lib/repo/types';

/**
 * Rail D — Instagram Business Discovery.
 *
 * Une seule phrase gouverne ce fichier, et elle vient du §7 du gate : **ce
 * n'est pas un moteur de recherche.** Business Discovery exige un `username`
 * professionnel connu à l'avance ; il n'énumère rien, ne suggère rien, et
 * n'accepte aucune requête par mot-clé, par lieu ou par hashtag. Il répond à
 * « que dit publiquement ce compte », jamais à « quels comptes existent ».
 *
 * La tentation, dans un projet dont le canal est le DM Instagram, est d'en
 * faire quand même une découverte — en devinant des usernames à partir de noms
 * d'entreprise, par exemple. Ce module refuse : `enrichKnownUsername` n'accepte
 * qu'un username **observé** ailleurs (site crawlé, page Facebook, source
 * indépendante), et `tests/meta/businessDiscovery.test.ts` vérifie qu'aucune
 * fonction exportée ne permet d'en fabriquer un.
 *
 * Ce qu'il apporte est réel malgré tout : quand notre crawl a trouvé
 * `instagram.com/xyz` sur un site, ce rail confirme que le compte existe,
 * qu'il est professionnel, et ce qu'il déclare de lui-même. C'est la différence
 * entre « un lien Instagram figure sur le site » et « ce compte professionnel
 * existe et se décrit ainsi ».
 */

export interface InstagramBusinessProfile {
  username: string;
  igId: string | null;
  biography: string | null;
  website: string | null;
  followersCount: number | null;
  mediaCount: number | null;
  observedAt: string;
}

/**
 * Champs demandés.
 *
 * La liste n'est pas un choix de confort : sur une cible tierce, seuls les
 * champs marqués « Public » dans la référence IG User sont retournés par
 * l'expansion `business_discovery`. Vérifié le 2026-08-10, ils sont exactement
 * `alt_text`, `biography`, `followers_count`, `id`, `media_count`, `username`,
 * `website`.
 *
 * En particulier `name` et `profile_picture_url` **ne le sont pas** : leur
 * documentation est cantonnée à la consultation de son propre compte. Les
 * demander donnerait une colonne vide qu'on finirait par croire renseignée —
 * la version discrète du fait inventé que la règle 2 de CLAUDE.md interdit.
 * `alt_text` concerne un média, pas un profil, et n'est donc pas demandé non
 * plus.
 */
export const BUSINESS_DISCOVERY_FIELDS = [
  'id',
  'username',
  'biography',
  'website',
  'followers_count',
  'media_count',
] as const;

interface GraphBusinessDiscovery {
  id?: string;
  username?: string;
  biography?: string;
  website?: string;
  followers_count?: number;
  media_count?: number;
}

interface GraphResponse {
  business_discovery?: GraphBusinessDiscovery;
  error?: { message?: string; code?: number };
}

/** Levé quand on tente d'enrichir sans username exploitable. */
export class UnknownUsernameError extends Error {
  constructor(readonly given: string | null) {
    super(
      'Business Discovery exige un username professionnel déjà connu. ' +
        'Il ne découvre pas de comptes et aucun username ne doit être deviné.',
    );
    this.name = 'UnknownUsernameError';
  }
}

export interface BusinessDiscoveryClientOptions {
  http: HttpClient;
  logger: Logger;
  credentials?: MetaCredentials;
  access?: SourceAccessState;
  now?: () => Date;
}

export class InstagramBusinessDiscoveryClient {
  private readonly http: HttpClient;
  private readonly logger: Logger;
  private readonly credentials: MetaCredentials;
  private readonly accessState: SourceAccessState;
  private readonly now: () => Date;

  constructor(options: BusinessDiscoveryClientOptions) {
    this.http = options.http;
    this.logger = options.logger;
    this.credentials = options.credentials ?? metaCredentials();
    this.accessState = options.access ?? instagramBusinessDiscoveryAccess(this.credentials);
    this.now = options.now ?? (() => new Date());
  }

  availability(): SourceAccessState {
    return this.accessState;
  }

  /**
   * Enrichit un compte dont le username est **déjà connu**.
   *
   * Refuse avant tout appel réseau si le username est absent ou illisible : un
   * username invalide envoyé à Graph reviendrait à sonder l'existence de
   * comptes par tâtonnement, ce qui est précisément l'usage que ce rail
   * s'interdit.
   */
  async enrichKnownUsername(knownUsername: string | null | undefined): Promise<InstagramBusinessProfile | null> {
    const username = normalizeInstagramHandle(knownUsername ?? null);
    if (!username) throw new UnknownUsernameError(knownUsername ?? null);

    if (this.accessState.status !== 'available') {
      throw new MetaAccessBlockedError(this.accessState);
    }

    const fields = `business_discovery.username(${username}){${BUSINESS_DISCOVERY_FIELDS.join(',')}}`;
    const params = new URLSearchParams({
      fields,
      access_token: this.credentials.accessToken ?? '',
    });
    const url = `${META_GRAPH_BASE}/${this.credentials.graphVersion}/${this.credentials.igUserId}?${params.toString()}`;

    const response = await this.http.get(url, { timeoutMs: 20_000, attempts: 2, noCache: true });

    let payload: GraphResponse;
    try {
      payload = JSON.parse(response.body) as GraphResponse;
    } catch {
      throw new MetaApiError(`réponse Graph illisible (HTTP ${response.status})`, null, 'api_error');
    }

    if (payload.error) {
      const error = classifyGraphError(payload.error.code ?? null, payload.error.message ?? 'erreur Graph');
      // Un compte inexistant, privé ou non professionnel remonte en erreur
      // Graph. Ce n'est pas une panne : c'est la réponse, et elle vaut « rien
      // à enrichir ».
      if (error.kind === 'api_error') {
        this.logger.info('instagram.business_discovery_miss', { username, code: error.code });
        return null;
      }
      throw error;
    }

    const profile = payload.business_discovery;
    if (!profile?.username) return null;

    return {
      username: normalizeInstagramHandle(profile.username) ?? username,
      igId: profile.id ?? null,
      biography: profile.biography?.trim() || null,
      website: normalizeUrl(profile.website ?? null),
      followersCount: typeof profile.followers_count === 'number' ? profile.followers_count : null,
      mediaCount: typeof profile.media_count === 'number' ? profile.media_count : null,
      observedAt: this.now().toISOString(),
    };
  }
}

/**
 * Traduit un profil en evidence.
 *
 * Les compteurs sont enregistrés parce qu'ils sont observés, **et** parce que
 * `config/scoring/` ne les lit pas : le §19 du gate refuse qu'un nombre
 * d'abonnés serve de jugement commercial, dans un sens comme dans l'autre. Ils
 * documentent le compte, ils ne le notent pas.
 */
export function evidenceFromInstagramProfile(profile: InstagramBusinessProfile): EvidenceInput[] {
  const sourceUrl = `https://www.instagram.com/${profile.username}/`;
  const evidence: EvidenceInput[] = [
    {
      field: 'instagram_handle',
      valueText: profile.username,
      provider: 'instagram_business_discovery',
      method: 'api',
      sourceUrl,
      confidence: 1,
      observedAt: profile.observedAt,
    },
    {
      field: 'instagram_professional_account',
      valueText: `compte professionnel confirmé : @${profile.username}`,
      valueJson: {
        igId: profile.igId,
        followersCount: profile.followersCount,
        mediaCount: profile.mediaCount,
        note: 'compteurs enregistrés comme observation, jamais lus par le scoring',
      },
      provider: 'instagram_business_discovery',
      method: 'api',
      sourceUrl,
      confidence: 1,
      observedAt: profile.observedAt,
    },
  ];

  if (profile.biography) {
    evidence.push({
      field: 'instagram_biography',
      valueText: profile.biography,
      provider: 'instagram_business_discovery',
      method: 'api',
      sourceUrl,
      confidence: 1,
      observedAt: profile.observedAt,
    });
  }
  if (profile.website) {
    // Le site déclaré par le compte est un pointeur de plus vers une source
    // que nous pouvons lire nous-mêmes. Il ne rattache rien seul : il repasse
    // par la vérification d'identité comme n'importe quel candidat.
    evidence.push({
      field: 'website_candidate',
      valueText: `${profile.website} — déclaré par le compte Instagram, non vérifié`,
      valueJson: { url: profile.website, from: 'instagram_business_discovery' },
      provider: 'instagram_business_discovery',
      method: 'api',
      sourceUrl,
      confidence: 0.6,
      observedAt: profile.observedAt,
    });
  }

  return evidence;
}
