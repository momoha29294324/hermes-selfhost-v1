import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INBOX_THREAD_LIST_OPERATIONS,
  INBOX_THREAD_LIST_PATH,
  extractInboxThreads,
  isInboxThreadListResponse,
  mergeNetworkInboxReads,
  resolveThreadIds,
  UNREADABLE_NETWORK_INBOX,
  type NetworkInboxRead,
} from '@/lib/instagram/inboxNetwork';
import { readRowAgeMs, type InboxRowMeasure } from '@/lib/instagram/inboxScan';
import {
  classifyAdjudicationRequest,
  isAllowedAdjudicationNavigation,
} from '@/lib/instagram/readOnlyGuard';

/**
 * IG5 R2 — la découverte des identifiants de fil, éprouvée sur le cas exact qui
 * a bloqué le rail.
 *
 * Le relevé LIVE du 20 août a mesuré une boîte pleine et ZÉRO identifiant : les
 * lignes de l'interface actuelle ne portent plus `a[href^="/direct/t/"]`. Le
 * rail lisait donc neuf conversations sans pouvoir en ouvrir une seule — et
 * `NOT_OPENED` sur toute la ligne ressemblait dangereusement à « personne n'a
 * répondu ».
 *
 * ---------------------------------------------------------------------------
 * Les fixtures sont SYNTHÉTIQUES, et c'est délibéré
 * ---------------------------------------------------------------------------
 *
 * Aucun corps de réponse du compte réel n'est recopié ici. Les handles, noms et
 * identifiants ci-dessous sont inventés ; seule la FORME (les chemins de clés)
 * vient de l'observation. Un fixture issu du vrai compte porterait des noms de
 * personnes et des aperçus de conversations privées dans Git, pour toujours.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VIEWER = 'compte_releveur';

interface ThreadSpec {
  readonly threadKey: string;
  readonly isGroup?: boolean | null;
  readonly title?: string | null;
  readonly lastActivityMs?: number | null;
  readonly users: readonly { username?: string; full_name?: string | null }[];
}

/** Un corps de réponse ayant la forme observée, avec des données inventées. */
function inboxBody(threads: readonly ThreadSpec[], container = 'threads_by_folder'): string {
  const edges = threads.map((thread) => ({
    cursor: `c_${thread.threadKey}`,
    node: {
      __typename: 'XDTMailboxThreadEdge',
      id: `node_${thread.threadKey}`,
      as_ig_direct_thread: {
        id: `ig_${thread.threadKey}`,
        thread_key: thread.threadKey,
        thread_id: `opaque_${thread.threadKey}`,
        thread_title: thread.title === undefined ? 'Titre' : thread.title,
        is_group: thread.isGroup === undefined ? false : thread.isGroup,
        last_activity_timestamp_ms: thread.lastActivityMs === undefined ? 1_700_000_000_000 : thread.lastActivityMs,
        users: thread.users,
        viewer: { username: VIEWER, id: '9' },
      },
    },
  }));
  return JSON.stringify({
    data: {
      get_slide_mailbox_for_iris_subscription: {
        [container]: { edges, page_info: { has_next_page: false, end_cursor: null } },
      },
    },
    extensions: { is_final: true },
  });
}

function readOf(threads: readonly ThreadSpec[]): NetworkInboxRead {
  return extractInboxThreads(inboxBody(threads));
}

function row(index: number, over: Partial<InboxRowMeasure> = {}): InboxRowMeasure {
  return {
    index,
    threadId: null,
    text: `Ligne ${index}`,
    timeLabel: null,
    imageAlts: [],
    ariaLabels: [],
    rect: { left: 96, right: 456, top: 300 + index * 72, bottom: 372 + index * 72 },
    ...over,
  };
}

/** Un corps GraphQL comme Instagram les poste : formulaire encodé. */
function graphqlPost(friendlyName: string, extra = ''): { url: string; method: string; postData: string } {
  return {
    url: `https://www.instagram.com${INBOX_THREAD_LIST_PATH}`,
    method: 'POST',
    postData: `av=17841400000000000&fb_api_req_friendly_name=${friendlyName}&variables=%7B%7D&doc_id=1234567890${extra}`,
  };
}

// ---------------------------------------------------------------------------
// §1 — la source, et rien qu'elle
// ---------------------------------------------------------------------------

describe('IG5 R2 — ce que le rail accepte d’écouter', () => {
  it('n’écoute qu’une opération nommée, sur un chemin nommé', () => {
    expect(INBOX_THREAD_LIST_OPERATIONS).toEqual(['PolarisDirectInboxQuery']);
    expect(
      isInboxThreadListResponse({ path: INBOX_THREAD_LIST_PATH, friendlyName: 'PolarisDirectInboxQuery', status: 200 }),
    ).toBe(true);
  });

  it('refuse un nom voisin, un autre chemin, un statut d’erreur, un nom absent', () => {
    const base = { path: INBOX_THREAD_LIST_PATH, friendlyName: 'PolarisDirectInboxQuery', status: 200 };
    // Une égalité, pas un préfixe : `…QueryFoo` est un autre nom.
    expect(isInboxThreadListResponse({ ...base, friendlyName: 'PolarisDirectInboxQueryFoo' })).toBe(false);
    expect(isInboxThreadListResponse({ ...base, friendlyName: 'polarisdirectinboxquery' })).toBe(false);
    expect(isInboxThreadListResponse({ ...base, friendlyName: null })).toBe(false);
    expect(isInboxThreadListResponse({ ...base, path: '/graphql/query' })).toBe(false);
    expect(isInboxThreadListResponse({ ...base, status: 500 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §2 — l'extraction
// ---------------------------------------------------------------------------

describe('IG5 R2 — lire la liste de fils', () => {
  it('rend l’identifiant, la contrepartie et la fraîcheur de chaque fil', () => {
    const read = readOf([
      { threadKey: '700000000000001', title: 'Atelier Zéro', users: [{ username: 'atelier_zero', full_name: 'Atelier Zéro' }] },
    ]);
    expect(read.readable).toBe(true);
    expect(read.threads).toHaveLength(1);
    expect(read.threads[0]?.threadKey).toBe('700000000000001');
    expect(read.threads[0]?.participants[0]?.username).toBe('atelier_zero');
    expect(read.threads[0]?.lastActivityMs).toBe(1_700_000_000_000);
  });

  it('trouve les fils quel que soit le conteneur qui les porte', () => {
    // Instagram sert la même forme sous deux dossiers, et rien ne garantit
    // qu'il n'en ajoutera pas un troisième. Le parcours est structurel.
    const other = extractInboxThreads(
      inboxBody([{ threadKey: '106047020788214', users: [{ username: 'autre_dossier' }] }], 'threads_by_system_folder_and_ig_inbox_folder'),
    );
    expect(other.readable).toBe(true);
    expect(other.threads[0]?.threadKey).toBe('106047020788214');
  });

  it('un corps malformé échoue FERMÉ — jamais « la boîte est vide »', () => {
    for (const body of ['', '{ pas du json', 'null', '[1,2,3]', '"texte"']) {
      const read = extractInboxThreads(body);
      expect(read.readable).toBe(false);
      expect(read.threads).toHaveLength(0);
    }
  });

  it('une réponse sans enveloppe « data » n’est pas une liste de fils', () => {
    expect(extractInboxThreads(JSON.stringify({ errors: [{ message: 'nope' }] })).readable).toBe(false);
  });

  it('un corps au-delà de la borne n’est pas lu, et ne conclut rien', () => {
    const read = extractInboxThreads(`{"data":{"x":"${'a'.repeat(9 * 1024 * 1024)}"}}`);
    expect(read.readable).toBe(false);
  });

  it('un identifiant qui n’a pas la forme d’un identifiant est ignoré', () => {
    const read = readOf([
      { threadKey: '../../etc/passwd' as string, users: [{ username: 'injection' }] },
      { threadKey: '12', users: [{ username: 'trop_court' }] },
      { threadKey: '700000000000001', users: [{ username: 'valide' }] },
    ]);
    expect(read.threads.map((thread) => thread.threadKey)).toEqual(['700000000000001']);
  });

  it('l’union de plusieurs réponses garde la lisibilité de la meilleure', () => {
    const merged = mergeNetworkInboxReads([
      extractInboxThreads('{ cassé'),
      readOf([{ threadKey: '700000000000001', users: [{ username: 'un' }] }]),
    ]);
    expect(merged.readable).toBe(true);
    expect(merged.threads).toHaveLength(1);
  });

  it('aucune réponse comprise reste « je ne sais pas »', () => {
    expect(mergeNetworkInboxReads([extractInboxThreads('{ cassé')]).readable).toBe(false);
    expect(mergeNetworkInboxReads([]).readable).toBe(false);
    expect(UNREADABLE_NETWORK_INBOX.readable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §3 — le rattachement ligne ↔ fil
// ---------------------------------------------------------------------------

describe('IG5 R2 — d’où vient l’identifiant d’une ligne', () => {
  it('1. le DOM l’emporte quand la ligne porte encore son lien', () => {
    const resolutions = resolveThreadIds({
      rows: [row(0, { threadId: '123', text: 'Atelier Zéro coucou' })],
      network: readOf([{ threadKey: '700000000000001', title: 'Atelier Zéro', users: [{ username: 'atelier_zero' }] }]),
      viewerHandle: VIEWER,
    });
    expect(resolutions[0]?.outcome).toBe('RESOLVED');
    expect(resolutions[0]?.source).toBe('DOM');
    expect(resolutions[0]?.basis).toBe('dom_link');
    expect(resolutions[0]?.threadId).toBe('123');
  });

  it('2. sans lien DOM, le handle exact de la liste réseau résout la ligne', () => {
    const resolutions = resolveThreadIds({
      rows: [row(0, { text: 'Atelier Zéro @atelier_zero Vous: bonjour' })],
      network: readOf([{ threadKey: '700000000000001', title: 'Atelier Zéro', users: [{ username: 'atelier_zero' }] }]),
      viewerHandle: VIEWER,
    });
    expect(resolutions[0]?.source).toBe('NETWORK');
    expect(resolutions[0]?.basis).toBe('network_handle_token');
    expect(resolutions[0]?.threadId).toBe('700000000000001');
    expect(resolutions[0]?.counterpartyHandle).toBe('atelier_zero');
  });

  it('3. le handle est reconnu NORMALISÉ, et seulement comme jeton entier', () => {
    const network = readOf([{ threadKey: '700000000000001', title: 'Zéro', users: [{ username: 'atelier_zero' }] }]);
    // Le handle tel qu'Instagram l'écrit parfois : arobase, majuscules, URL.
    for (const text of ['Zut @Atelier_Zero a écrit', 'Zut instagram.com/atelier_zero/ ']) {
      expect(resolveThreadIds({ rows: [row(0, { text })], network, viewerHandle: VIEWER })[0]?.basis).toBe(
        'network_handle_token',
      );
    }
    // Un préfixe n'est pas le handle : `atelier_zer` ne vaut pas `atelier_zero`,
    // et `atelier_zeroxx` non plus.
    for (const text of ['Zut atelier_zer a écrit', 'Zut atelier_zeroxx a écrit']) {
      expect(resolveThreadIds({ rows: [row(0, { text })], network, viewerHandle: VIEWER })[0]?.basis).not.toBe(
        'network_handle_token',
      );
    }
  });

  it('3 bis. le handle est aussi cherché dans les aria-labels et les alt d’images', () => {
    const network = readOf([{ threadKey: '700000000000001', title: 'Zéro', users: [{ username: 'atelier_zero' }] }]);
    const viaAlt = resolveThreadIds({
      rows: [row(0, { text: 'sans rapport', imageAlts: ['Photo de profil de atelier_zero'] })],
      network,
      viewerHandle: VIEWER,
    });
    expect(viaAlt[0]?.basis).toBe('network_handle_token');
  });

  it('le nom d’affichage résout, mais seulement en PRÉFIXE et à la frontière d’un mot', () => {
    const network = readOf([
      { threadKey: '700000000000001', title: 'Julie', users: [{ username: 'julie_x', full_name: 'Julie' }] },
      { threadKey: '106047020788214', title: 'Julien Dupont', users: [{ username: 'julien_y', full_name: 'Julien Dupont' }] },
    ]);
    const resolutions = resolveThreadIds({
      rows: [row(0, { text: 'Julien Dupont Vous: à bientôt' }), row(1, { text: 'Julie Vous: ok' })],
      network,
      viewerHandle: VIEWER,
    });
    // Sans la frontière, « Julie » serait candidate pour la ligne de Julien, et
    // l'ambiguïté fabriquée ferait échouer les DEUX lignes.
    expect(resolutions[0]?.threadId).toBe('106047020788214');
    expect(resolutions[1]?.threadId).toBe('700000000000001');
    expect(resolutions[0]?.basis).toBe('network_display_name');
  });

  it('un nom cité DANS un message ne rattache rien — il n’est pas en tête de ligne', () => {
    const network = readOf([
      { threadKey: '700000000000001', title: 'Atelier Zéro', users: [{ username: 'atelier_zero', full_name: 'Atelier Zéro' }] },
    ]);
    const resolutions = resolveThreadIds({
      rows: [row(0, { text: 'Karim Vous: as-tu vu Atelier Zéro hier ?' })],
      network,
      viewerHandle: VIEWER,
    });
    expect(resolutions[0]?.outcome).toBe('NO_CANDIDATE');
    expect(resolutions[0]?.threadId).toBeNull();
  });

  it('4. deux candidats ambigus : AUCUN n’est choisi, et les deux lignes échouent', () => {
    const network = readOf([
      { threadKey: '700000000000001', title: 'Homonyme', users: [{ username: 'premier', full_name: 'Homonyme' }] },
      { threadKey: '106047020788214', title: 'Homonyme', users: [{ username: 'second', full_name: 'Homonyme' }] },
    ]);
    const resolutions = resolveThreadIds({
      rows: [row(0, { text: 'Homonyme Vous: a' }), row(1, { text: 'Homonyme Vous: b' })],
      network,
      viewerHandle: VIEWER,
    });
    for (const resolution of resolutions) {
      expect(resolution.outcome).toBe('AMBIGUOUS');
      expect(resolution.threadId).toBeNull();
      expect(resolution.source).toBeNull();
    }
  });

  it('le résultat ne dépend pas de l’ordre de lecture de la boîte', () => {
    const network = readOf([
      { threadKey: '700000000000001', title: 'Homonyme', users: [{ username: 'premier', full_name: 'Homonyme' }] },
      { threadKey: '106047020788214', title: 'Homonyme', users: [{ username: 'second', full_name: 'Homonyme' }] },
    ]);
    const rows = [row(0, { text: 'Homonyme Vous: a' }), row(1, { text: 'Homonyme Vous: b' })];
    const forward = resolveThreadIds({ rows, network, viewerHandle: VIEWER });
    const backward = resolveThreadIds({ rows: [...rows].reverse(), network, viewerHandle: VIEWER });
    expect(forward.map((r) => r.threadId)).toEqual(backward.map((r) => r.threadId));
  });

  it('un fil déjà pris par une autre ligne ne peut pas être attribué deux fois', () => {
    // Deux lignes réclament le même fil : personne ne l'obtient.
    const network = readOf([{ threadKey: '700000000000001', title: 'Unique', users: [{ username: 'unique_x' }] }]);
    const resolutions = resolveThreadIds({
      rows: [row(0, { text: 'Unique a @unique_x' }), row(1, { text: 'Unique b @unique_x' })],
      network,
      viewerHandle: VIEWER,
    });
    expect(resolutions.filter((r) => r.threadId !== null)).toHaveLength(0);
  });

  it('5. une entrée réseau sans participant exploitable ne résout rien', () => {
    const cases: readonly ThreadSpec[][] = [
      // Un fil de groupe : à qui attribuerait-on la réponse ?
      [{ threadKey: '700000000000001', title: 'Équipe', isGroup: true, users: [{ username: 'a' }, { username: 'b' }] }],
      // Un fil dont on ne SAIT PAS s'il est de groupe. Une inconnue n'est pas un « non ».
      [{ threadKey: '700000000000001', title: 'Équipe', isGroup: null, users: [{ username: 'a' }] }],
      // Un fil qui ne nomme personne.
      [{ threadKey: '700000000000001', title: 'Équipe', users: [] }],
      // Un fil qui ne nomme que nous.
      [{ threadKey: '700000000000001', title: 'Équipe', users: [{ username: VIEWER }] }],
      // Un participant sans handle lisible.
      [{ threadKey: '700000000000001', title: 'Équipe', users: [{ full_name: 'Sans handle' }] }],
    ];
    for (const threads of cases) {
      const resolutions = resolveThreadIds({
        rows: [row(0, { text: 'Équipe Vous: bonjour' })],
        network: readOf(threads),
        viewerHandle: VIEWER,
      });
      expect(resolutions[0]?.threadId).toBeNull();
      expect(resolutions[0]?.outcome).toBe('NO_CANDIDATE');
    }
  });

  it('7. sans réponse réseau utile, le comportement d’avant est CONSERVÉ', () => {
    const resolutions = resolveThreadIds({
      rows: [row(0, { text: 'Atelier Zéro Vous: bonjour' }), row(1, { threadId: '77', text: 'Autre' })],
      network: UNREADABLE_NETWORK_INBOX,
      viewerHandle: VIEWER,
    });
    // La ligne sans lien reste fermée…
    expect(resolutions[0]?.outcome).toBe('NO_CANDIDATE');
    expect(resolutions[0]?.threadId).toBeNull();
    // …et celle qui porte un lien continue de marcher, comme avant.
    expect(resolutions[1]?.threadId).toBe('77');
    expect(resolutions[1]?.source).toBe('DOM');
  });

  it('aucun identifiant n’est FABRIQUÉ : tout ce qui sort vient de la liste ou du DOM', () => {
    const network = readOf([
      { threadKey: '700000000000001', title: 'Atelier Zéro', users: [{ username: 'atelier_zero' }] },
      { threadKey: '106047020788214', title: 'Beta', users: [{ username: 'beta_x' }] },
    ]);
    const rows = [row(0, { text: 'Atelier Zéro x' }), row(1, { text: 'Beta y' }), row(2, { text: 'Gamma z' })];
    const known = new Set(network.threads.map((thread) => thread.threadKey));
    for (const resolution of resolveThreadIds({ rows, network, viewerHandle: VIEWER })) {
      if (resolution.threadId === null) continue;
      expect(known.has(resolution.threadId)).toBe(true);
    }
  });

  it('une absence d’identifiant n’est jamais une absence de réponse', () => {
    const resolutions = resolveThreadIds({
      rows: [row(0, { text: 'Inconnu' })],
      network: UNREADABLE_NETWORK_INBOX,
      viewerHandle: VIEWER,
    });
    // L'issue nomme l'ignorance, elle ne la traduit pas en fait négatif.
    expect(['NO_CANDIDATE', 'AMBIGUOUS']).toContain(resolutions[0]?.outcome);
    expect(resolutions[0]?.detail).toMatch(/aucune URL n’est fabriquée|ne correspond/);
  });
});

// ---------------------------------------------------------------------------
// §4 — la navigation, et la garde
// ---------------------------------------------------------------------------

describe('IG5 R2 — ce que l’identifiant permet, et ce qu’il ne permet pas', () => {
  it('8. un identifiant réseau donne une URL de fil NAVIGABLE en lecture', () => {
    const read = readOf([{ threadKey: '17849017046724398', users: [{ username: 'atelier_zero' }] }]);
    const threadKey = read.threads[0]?.threadKey ?? '';
    expect(isAllowedAdjudicationNavigation(`https://www.instagram.com/direct/t/${threadKey}/`)).toBe(true);
    // Et la lecture de ce fil est un GET, donc autorisée ; un POST ne l'est pas.
    const url = `https://www.instagram.com/direct/t/${threadKey}/`;
    expect(classifyAdjudicationRequest({ url, method: 'GET', postData: null }).allowed).toBe(true);
    expect(classifyAdjudicationRequest({ url, method: 'POST', postData: null }).allowed).toBe(false);
  });

  it('la liste réseau est autorisée parce qu’elle LIT — rien n’a été élargi pour elle', () => {
    const decision = classifyAdjudicationRequest(graphqlPost('PolarisDirectInboxQuery'));
    expect(decision.allowed).toBe(true);
    // La règle est celle qui existait déjà : un point d'entrée de lecture, pas
    // une exception nommée. Aucune opération n'a été ajoutée à une liste blanche.
    expect(decision.allowed && decision.rule).toBe('read_only_endpoint');
  });

  it('9. l’envoi d’un DM reste REFUSÉ', () => {
    const decision = classifyAdjudicationRequest(graphqlPost('IGDirectTextSendMutation'));
    expect(decision.allowed).toBe(false);
    expect(!decision.allowed && decision.rule).toBe('graphql_effect');
  });

  it('10. marquer un fil comme lu reste REFUSÉ, validation comprise', () => {
    for (const name of ['useIGDMarkThreadAsReadMutation', 'useIGDMarkThreadAsReadValidationMutation']) {
      expect(classifyAdjudicationRequest(graphqlPost(name)).allowed).toBe(false);
    }
  });

  it('11. une mutation INCONNUE reste refusée sans avoir à être nommée', () => {
    for (const name of ['CetteMutationNExistePasEncoreMutation', 'IGDReactionMutation', 'PolarisFollowMutation']) {
      expect(classifyAdjudicationRequest(graphqlPost(name)).allowed).toBe(false);
    }
    // Et un chemin d'effet reste refusé quelle que soit la méthode.
    expect(
      classifyAdjudicationRequest({
        url: 'https://www.instagram.com/api/v1/friendships/create/1/',
        method: 'GET',
        postData: null,
      }).allowed,
    ).toBe(false);
  });

  it('une mutation refusée ne peut pas se déguiser en liste de fils', () => {
    // Les deux barrières sont indépendantes : même si un corps portait le nom de
    // la lecture, la règle `mutation` du corps le refuserait quand même.
    const disguised = graphqlPost('PolarisDirectInboxQuery', '&server_timestamps=true&fb_api_caller_class=RelayModern%20mutation');
    expect(classifyAdjudicationRequest(disguised).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §5 — la vie privée
// ---------------------------------------------------------------------------

describe('IG5 R2 — ce qui ne sort pas de la mémoire', () => {
  it('12. aucun corps brut ne survit à l’extraction', () => {
    const body = inboxBody([
      { threadKey: '700000000000001', title: 'Atelier Zéro', users: [{ username: 'atelier_zero', full_name: 'Atelier Zéro' }] },
    ]);
    const read = extractInboxThreads(body);
    const serialized = JSON.stringify(read);
    // Ni le corps, ni ses parties reconnaissables.
    expect(serialized).not.toContain(body);
    expect(serialized).not.toContain('get_slide_mailbox_for_iris_subscription');
    expect(serialized).not.toContain('opaque_700000000000001');
    // La forme rendue est close : exactement ces champs, et pas un de plus.
    expect(Object.keys(read.threads[0] ?? {}).sort()).toEqual(
      ['isGroup', 'lastActivityMs', 'participants', 'threadKey', 'title'].sort(),
    );
    expect(Object.keys(read.threads[0]?.participants[0] ?? {}).sort()).toEqual(['fullName', 'username']);
  });

  it('le rail n’écrit ni ne journalise le corps qu’il vient de lire', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/lib/instagram/playwrightInboundRail.ts'), 'utf8');
    // Le corps est nommé `body`, et il ne va QUE dans l'extracteur.
    const usages = [...source.matchAll(/\bbody\b/g)].length;
    expect(usages).toBeGreaterThan(0);
    expect(source).toContain('extractInboxThreads(body)');
    expect(source).not.toMatch(/log\.(info|warn|error|debug)\([^)]*\bbody\b/);
    expect(source).not.toMatch(/writeFileSync|appendFileSync|createWriteStream/);
  });

  it('le rail entrant n’a toujours aucune primitive d’action', () => {
    // Les COMMENTAIRES sont retirés avant de chercher : ce fichier explique
    // longuement ce qu'il ne fait pas, et une prose qui cite `click` ne clique
    // pas. Ce qu'on cherche est du code.
    const source = readFileSync(resolve(process.cwd(), 'src/lib/instagram/playwrightInboundRail.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const forbidden of ['.click(', '.fill(', '.type(', '.press(', 'pressSequentially', 'SEND_CONTROL_SELECTORS']) {
      expect(code).not.toContain(forbidden);
    }
    // Et la seule chose qu'il fait sortir vers Instagram reste une navigation.
    expect(code).toContain('this.navigate(page');
  });
});

// ---------------------------------------------------------------------------
// §6 — le bug secondaire : la fraîcheur lue au bon endroit
// ---------------------------------------------------------------------------

describe('IG5 R2 — l’âge d’une ligne se lit sur son horodatage', () => {
  it('un « 11 ans » écrit DANS le message ne devient pas l’âge du fil', () => {
    // Le cas exact du relevé LIVE : la ligne est tronquée à 220 caractères, son
    // horodatage a sauté avec la troncature, et le dernier jeton temporel
    // restant appartenait à l'aperçu.
    const bavarde = row(0, {
      text: 'Karim Ça fait 11 ans que je bosse dans le atelier, et je peux te dire que ce genre de méthode',
      timeLabel: '3 j',
    });
    expect(readRowAgeMs(bavarde)).toBe(3 * 24 * 3_600_000);
    expect(readRowAgeMs(bavarde)).not.toBe(11 * 365 * 24 * 3_600_000);
  });

  it('un horodatage réel est lu correctement', () => {
    expect(readRowAgeMs(row(0, { timeLabel: '12 h' }))).toBe(12 * 3_600_000);
    expect(readRowAgeMs(row(0, { timeLabel: 'il y a 45 min' }))).toBe(45 * 60_000);
    expect(readRowAgeMs(row(0, { timeLabel: '11 sem.' }))).toBe(11 * 7 * 24 * 3_600_000);
    expect(readRowAgeMs(row(0, { timeLabel: 'Maintenant' }))).toBe(0);
  });

  it('sans nœud d’horodatage, l’âge est INCONNU — pas déduit de l’aperçu', () => {
    const sansDate = row(0, { text: 'Karim Rendez-vous dans 2 h au garage', timeLabel: null });
    expect(readRowAgeMs(sansDate)).toBeNull();
  });

  it('le scanner de page cherche l’horodatage dans son propre nœud', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/lib/instagram/inboxScan.ts'), 'utf8');
    expect(source).toContain("querySelectorAll('time')");
    // Et l'âge du rail ne repart JAMAIS du texte de la ligne.
    const rail = readFileSync(resolve(process.cwd(), 'src/lib/instagram/playwrightInboundRail.ts'), 'utf8');
    expect(rail).toContain('readRowAgeMs(row)');
    expect(rail).not.toContain('parseRelativeAgeMs(row.text)');
  });
});
