import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_THREAD_DETAIL_BYTES,
  THREAD_DETAIL_OPERATIONS,
  THREAD_DETAIL_PATH,
  classifyAuthor,
  extractThreadDetail,
  isThreadDetailResponse,
  mergeThreadDetailReads,
  soleCounterpartyOf,
} from '@/lib/instagram/threadDetailNetwork';
import {
  instagramNetworkMessageFingerprint,
  NETWORK_MESSAGE_FINGERPRINT_VERSION,
} from '@/lib/instagram/inboundThread';
import { chooseThreadScope } from '@/lib/instagram/deliveryProof';
import { classifyAdjudicationRequest } from '@/lib/instagram/readOnlyGuard';

/**
 * IG5 R3 — le lecteur de messages réseau, exercé sans navigateur.
 *
 * ---------------------------------------------------------------------------
 * Aucune conversation réelle n'apparaît dans ce fichier
 * ---------------------------------------------------------------------------
 *
 * Les corps ci-dessous sont FABRIQUÉS à la forme observée le 20 août 2026 sur
 * `@hermesagency_` — les noms de champs, leurs types, leur imbrication — et
 * remplis de valeurs inventées. Aucun texte, aucun handle, aucun identifiant de
 * message réel n'est recopié ici : la forme d'une réponse est une observation
 * technique, son contenu est la conversation privée de quelqu'un.
 *
 * C'est aussi ce qui rend ces tests capables d'exercer les cas qu'une vraie
 * boîte mettrait des mois à produire — un fil de groupe, un horodatage aberrant,
 * un expéditeur tiers — sans attendre qu'ils arrivent.
 */

/**
 * Le CODE d'un module, commentaires retirés.
 *
 * Une assertion « ce fichier ne contient pas X » est fausse dès que X est
 * expliqué en prose — et ces modules expliquent beaucoup. Ce qui se vérifie
 * ici, c'est ce que le module FAIT.
 */
function executableSourceOf(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const ACCOUNT = 'compte.releve';
const COUNTERPARTY = 'atelier.fictif';
const THIRD_PARTY = 'quelqun.dautre';
const THREAD = '17840000000000001';
const OTHER_THREAD = '17840000000000002';

interface MessageSpec {
  readonly id: string;
  readonly sender: string | null;
  readonly text: string | null;
  readonly at: string;
  readonly contentType?: string | null;
  readonly quoted?: MessageSpec;
  readonly omitTimestamp?: boolean;
  readonly badTimestamp?: string;
}

function node(spec: MessageSpec): Record<string, unknown> {
  const sender =
    spec.sender === null
      ? null
      : { user_dict: { username: spec.sender, full_name: 'Nom Fictif', id: '900000000' } };
  const base: Record<string, unknown> = {
    __typename: 'SlideMessage',
    id: spec.id,
    message_id: spec.id,
    text_body: spec.text,
    content: spec.text === null ? null : { __typename: 'SlideMessageText', text_body: spec.text },
    content_type: spec.contentType === undefined ? 'TEXT' : spec.contentType,
    sender,
    sender_fbid: '17840000000000900',
    thread_fbid: '340282366000000000000000',
    is_tombstone_revealable: null,
  };
  if (spec.badTimestamp !== undefined) base['timestamp_ms'] = spec.badTimestamp;
  else if (spec.omitTimestamp !== true) base['timestamp_ms'] = String(new Date(spec.at).getTime());
  // La CITATION d'un message plus ancien : elle porte les mêmes champs, et un
  // parcours structurel la compterait comme un message du fil.
  if (spec.quoted !== undefined) base['replied_to_message'] = node(spec.quoted);
  return base;
}

interface PayloadSpec {
  readonly threadKey?: string | null;
  readonly isGroup?: boolean | null;
  readonly users?: readonly string[];
  readonly messages?: readonly MessageSpec[];
  readonly omitSlideMessages?: boolean;
  readonly omitContainer?: boolean;
  readonly edgesNotAnArray?: boolean;
}

function payload(spec: PayloadSpec = {}): string {
  if (spec.omitContainer === true) return JSON.stringify({ data: { get_slide_thread_nullable: null } });
  const thread: Record<string, unknown> = {
    id: 'VGhyZWFkOjE=',
    thread_key: spec.threadKey === undefined ? THREAD : spec.threadKey,
    thread_id: '340282366000000000000000',
    is_group: spec.isGroup === undefined ? false : spec.isGroup,
    thread_title: 'Atelier Fictif',
    last_activity_timestamp_ms: '1755000000000',
    users: (spec.users ?? [ACCOUNT, COUNTERPARTY]).map((username) => ({
      username,
      full_name: 'Nom Fictif',
      id: '900000000',
    })),
  };
  if (spec.omitSlideMessages !== true) {
    thread['slide_messages'] = {
      edges: spec.edgesNotAnArray === true ? {} : (spec.messages ?? []).map((message) => ({ node: node(message) })),
    };
  }
  return JSON.stringify({ data: { get_slide_thread_nullable: { as_ig_direct_thread: thread } } });
}

const OUR_DM: MessageSpec = {
  id: 'mid.$synthAAAAAAAAAAAAAAAAAAAAAAA01',
  sender: ACCOUNT,
  text: 'Bonjour, comment vos clients vous trouvent aujourd’hui ?',
  at: '2026-08-17T16:05:04.420Z',
};
const THEIR_REPLY: MessageSpec = {
  id: 'mid.$synthAAAAAAAAAAAAAAAAAAAAAAA02',
  sender: COUNTERPARTY,
  text: 'Bonjour, oui je veux bien en savoir plus.',
  at: '2026-08-18T09:12:00.000Z',
};

function read(body: string, expected = THREAD) {
  return extractThreadDetail({ body, expectedThreadKey: expected });
}

// ---------------------------------------------------------------------------
// §1 / §2 — la lecture d'un payload valide
// ---------------------------------------------------------------------------

describe('IG5 R3 §2 — un payload valide devient des messages normalisés', () => {
  it('lit l’identifiant, l’expéditeur, l’horodatage et le texte de chaque message', () => {
    const result = read(payload({ messages: [OUR_DM, THEIR_REPLY] }));

    expect(result.readable).toBe(true);
    expect(result.identity).toBe('MATCH');
    expect(result.threadKey).toBe(THREAD);
    expect(result.messages).toHaveLength(2);

    const [first, second] = result.messages;
    expect(first?.providerMessageId).toBe(OUR_DM.id);
    expect(first?.senderUsername).toBe(ACCOUNT);
    expect(first?.timestampMs).toBe(new Date(OUR_DM.at).getTime());
    expect(first?.text).toBe(OUR_DM.text);
    expect(first?.contentKind).toBe('TEXT');
    expect(second?.senderUsername).toBe(COUNTERPARTY);
  });

  it('rend les messages du plus ancien au plus récent, quel que soit l’ordre de la réponse', () => {
    const result = read(payload({ messages: [THEIR_REPLY, OUR_DM] }));
    expect(result.messages.map((message) => message.providerMessageId)).toEqual([OUR_DM.id, THEIR_REPLY.id]);
  });

  it('la citation d’un message plus ancien n’est pas un message du fil', () => {
    // `replied_to_message` porte `message_id`, `text_body`, `timestamp_ms` et
    // `sender` : un parcours structurel en ferait un troisième message.
    const quoted: MessageSpec = {
      id: 'mid.$synthAAAAAAAAAAAAAAAAAAAAAAA99',
      sender: COUNTERPARTY,
      text: 'un message bien plus ancien',
      at: '2024-01-01T10:00:00.000Z',
    };
    const result = read(payload({ messages: [OUR_DM, { ...THEIR_REPLY, quoted }] }));

    expect(result.messages).toHaveLength(2);
    expect(result.messages.map((message) => message.providerMessageId)).not.toContain(quoted.id);
  });

  it('un message sans texte reste un message — il n’est ni inventé ni effacé', () => {
    const photo: MessageSpec = {
      id: 'mid.$synthAAAAAAAAAAAAAAAAAAAAAAA03',
      sender: COUNTERPARTY,
      text: null,
      at: '2026-08-18T10:00:00.000Z',
      contentType: 'XMA_MEDIA_SHARE',
    };
    const result = read(payload({ messages: [OUR_DM, photo] }));

    expect(result.messages).toHaveLength(2);
    const last = result.messages[1];
    expect(last?.contentKind).toBe('NON_TEXT');
    expect(last?.text).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §2 — fail closed : ce qui manque n'est jamais comblé
// ---------------------------------------------------------------------------

describe('IG5 R3 §2 — ce qui n’est pas lisible n’est pas inventé', () => {
  it('la forme réelle « mid.$… » est acceptée — le premier motif la rejetait', () => {
    // Régression LIVE du 20 août 2026 : un alphabet énuméré sans `$` faisait
    // rendre « fil lu, zéro message » sur les huit fils. Un identifiant tiers
    // trop contraint ne refuse pas une donnée douteuse, il efface des messages.
    const result = read(payload({ messages: [OUR_DM] }));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.providerMessageId).toContain('$');
    expect(result.rejected).toBe(0);
  });

  it('un identifiant vide, trop court ou porteur d’espace reste refusé', () => {
    const body = payload({ messages: [OUR_DM] });
    for (const bad of ['', 'court', 'avec espace dedans']) {
      const broken = body.replace(`"message_id":"${OUR_DM.id}"`, `"message_id":"${bad}"`);
      expect(read(broken).messages).toHaveLength(0);
      expect(read(broken).rejected).toBe(1);
    }
  });

  it('un message sans identifiant natif est écarté, et compté', () => {
    const body = payload({ messages: [OUR_DM, THEIR_REPLY] });
    const broken = body.replace(`"message_id":"${THEIR_REPLY.id}"`, '"message_id":null');
    const result = read(broken);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.providerMessageId).toBe(OUR_DM.id);
    expect(result.rejected).toBe(1);
  });

  it('un message sans horodatage exploitable est écarté plutôt que daté au hasard', () => {
    const undated: MessageSpec = { ...THEIR_REPLY, omitTimestamp: true };
    const result = read(payload({ messages: [OUR_DM, undated] }));

    expect(result.messages).toHaveLength(1);
    expect(result.rejected).toBe(1);
  });

  it('un horodatage hors bornes ne devient pas une date plausible', () => {
    const absurd: MessageSpec = { ...THEIR_REPLY, badTimestamp: '99999999999999' };
    const result = read(payload({ messages: [OUR_DM, absurd] }));

    expect(result.messages).toHaveLength(1);
    expect(result.rejected).toBe(1);
  });

  it('un message dont l’expéditeur n’est pas nommé n’est pas attribuable', () => {
    const anonymous: MessageSpec = { ...THEIR_REPLY, sender: null };
    const result = read(payload({ messages: [OUR_DM, anonymous] }));

    expect(result.messages).toHaveLength(1);
    expect(result.rejected).toBe(1);
  });

  it('un corps GraphQL malformé ne rend jamais « ce fil est vide »', () => {
    for (const body of ['', '{', 'null', '[]', '{"data":{}}', '{"data":{"get_slide_thread_nullable":null}}']) {
      const result = read(body);
      expect(result.readable).toBe(false);
      expect(result.identity).toBe('UNREADABLE');
      expect(result.messages).toHaveLength(0);
    }
  });

  it('un corps au-delà de la borne de lecture n’est pas lu, et ne conclut rien', () => {
    const result = read('x'.repeat(MAX_THREAD_DETAIL_BYTES + 1));
    expect(result.readable).toBe(false);
    expect(result.identity).toBe('UNREADABLE');
  });

  it('le bon fil sans conteneur de messages n’est pas un fil sans messages', () => {
    const result = read(payload({ omitSlideMessages: true }));
    // La réponse nomme bien le fil, mais elle ne portait pas la conversation.
    expect(result.threadKey).toBe(THREAD);
    expect(result.readable).toBe(false);
    expect(result.identity).toBe('UNREADABLE');
  });

  it('une liste d’arêtes qui n’en est pas une abandonne la lecture', () => {
    const result = read(payload({ edgesNotAnArray: true }));
    expect(result.readable).toBe(false);
  });

  it('un fil réellement vide se distingue d’un fil illisible', () => {
    const result = read(payload({ messages: [] }));
    expect(result.readable).toBe(true);
    expect(result.identity).toBe('MATCH');
    expect(result.messages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §3 — l'identité du fil
// ---------------------------------------------------------------------------

describe('IG5 R3 §3 — une réponse qui parle d’un autre fil ne donne aucun message', () => {
  it('rend THREAD_IDENTITY_MISMATCH et zéro message', () => {
    const result = read(payload({ threadKey: OTHER_THREAD, messages: [OUR_DM, THEIR_REPLY] }));

    expect(result.identity).toBe('THREAD_IDENTITY_MISMATCH');
    expect(result.messages).toHaveLength(0);
    expect(result.threadKey).toBe(OTHER_THREAD);
  });

  it('un conteneur sans identifiant lisible n’autorise aucun message', () => {
    for (const key of [null, '', 'pas-un-nombre', '42']) {
      const result = read(payload({ threadKey: key, messages: [OUR_DM, THEIR_REPLY] }));
      expect(result.messages).toHaveLength(0);
      expect(result.readable).toBe(false);
    }
  });

  it('un identifiant attendu invalide refuse la lecture plutôt que de tout accepter', () => {
    const result = extractThreadDetail({ body: payload({ messages: [OUR_DM] }), expectedThreadKey: 'nimporte' });
    expect(result.readable).toBe(false);
    expect(result.messages).toHaveLength(0);
  });

  it('quatorze réponses voisines et deux bonnes : seules les bonnes comptent', () => {
    // La situation RÉELLE mesurée le 20 août : ouvrir un fil fait revenir seize
    // réponses de détail, dont deux nomment le fil ouvert.
    const neighbours = Array.from({ length: 14 }, (_, index) =>
      read(
        payload({
          threadKey: `1784900000000${String(index).padStart(4, '0')}`,
          messages: [{ ...THEIR_REPLY, id: `mid.$VOISIN${String(index).padStart(24, '0')}` }],
        }),
      ),
    );
    const ours = [read(payload({ messages: [OUR_DM, THEIR_REPLY] })), read(payload({ messages: [OUR_DM, THEIR_REPLY] }))];

    const merged = mergeThreadDetailReads([...neighbours, ...ours]);

    expect(merged.identity).toBe('MATCH');
    expect(merged.messages).toHaveLength(2);
    expect(merged.messages.map((message) => message.providerMessageId)).toEqual([OUR_DM.id, THEIR_REPLY.id]);
  });

  it('seize réponses dont AUCUNE ne nomme le fil demandé ne rendent aucun message', () => {
    const neighbours = Array.from({ length: 16 }, (_, index) =>
      read(payload({ threadKey: `1784900000000${String(index).padStart(4, '0')}`, messages: [THEIR_REPLY] })),
    );
    const merged = mergeThreadDetailReads(neighbours);

    expect(merged.identity).toBe('THREAD_IDENTITY_MISMATCH');
    expect(merged.readable).toBe(false);
    expect(merged.messages).toHaveLength(0);
  });

  it('aucune réponse du tout reste « je n’ai pas su », jamais « il n’y a rien »', () => {
    const merged = mergeThreadDetailReads([]);
    expect(merged.readable).toBe(false);
    expect(merged.identity).toBe('UNREADABLE');
  });
});

// ---------------------------------------------------------------------------
// §4 — la direction, par l'identité de l'expéditeur
// ---------------------------------------------------------------------------

describe('IG5 R3 §4 — qui parle est LU, jamais déduit d’une position', () => {
  const context = { accountHandle: ACCOUNT, counterpartyHandle: COUNTERPARTY };

  it('l’expéditeur est le compte qui relève → SELF', () => {
    expect(classifyAuthor({ ...context, senderUsername: ACCOUNT })).toBe('SELF');
    expect(classifyAuthor({ ...context, senderUsername: `@${ACCOUNT.toUpperCase()}` })).toBe('SELF');
  });

  it('l’expéditeur est exactement la contrepartie → COUNTERPARTY', () => {
    expect(classifyAuthor({ ...context, senderUsername: COUNTERPARTY })).toBe('COUNTERPARTY');
  });

  it('un expéditeur tiers → AMBIGUOUS, jamais entrant par défaut', () => {
    expect(classifyAuthor({ ...context, senderUsername: THIRD_PARTY })).toBe('AMBIGUOUS');
  });

  it('sans contrepartie établie, personne n’est promu entrant', () => {
    expect(classifyAuthor({ accountHandle: ACCOUNT, counterpartyHandle: null, senderUsername: COUNTERPARTY })).toBe(
      'AMBIGUOUS',
    );
  });

  it('« le dernier message n’est pas de nous » ne suffit à rien', () => {
    // Le dernier message vient d'un tiers. Un rail qui conclurait « donc c'est
    // une réponse du prospect » attribuerait ses mots à quelqu'un d'autre.
    const result = read(
      payload({
        users: [ACCOUNT, COUNTERPARTY, THIRD_PARTY],
        messages: [OUR_DM, { ...THEIR_REPLY, sender: THIRD_PARTY }],
      }),
    );
    const last = result.messages[result.messages.length - 1];
    expect(last?.senderUsername).toBe(THIRD_PARTY);
    expect(classifyAuthor({ ...context, senderUsername: last?.senderUsername ?? '' })).toBe('AMBIGUOUS');
  });
});

describe('IG5 R3 §4 — la contrepartie d’un fil 1:1', () => {
  it('un fil 1:1 prouvé nomme exactement une contrepartie', () => {
    expect(soleCounterpartyOf(read(payload({ messages: [OUR_DM] })), ACCOUNT)).toBe(COUNTERPARTY);
  });

  it('un fil de groupe n’en nomme aucune', () => {
    expect(soleCounterpartyOf(read(payload({ isGroup: true, messages: [OUR_DM] })), ACCOUNT)).toBeNull();
  });

  it('un fil dont l’appartenance au groupe est inconnue n’est pas supposé 1:1', () => {
    expect(soleCounterpartyOf(read(payload({ isGroup: null, messages: [OUR_DM] })), ACCOUNT)).toBeNull();
  });

  it('trois participants ne donnent pas une contrepartie « principale »', () => {
    const result = read(payload({ users: [ACCOUNT, COUNTERPARTY, THIRD_PARTY], messages: [OUR_DM] }));
    expect(soleCounterpartyOf(result, ACCOUNT)).toBeNull();
  });

  it('une réponse écartée pour identité ne nomme personne', () => {
    const result = read(payload({ threadKey: OTHER_THREAD, messages: [OUR_DM] }));
    expect(soleCounterpartyOf(result, ACCOUNT)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §5 — l'identité fournisseur du message
// ---------------------------------------------------------------------------

describe('IG5 R3 §5 — même message Instagram, même identité logique', () => {
  const of = (providerMessageId: string, threadId = THREAD): string =>
    instagramNetworkMessageFingerprint({ accountHandle: ACCOUNT, threadId, providerMessageId });

  it('l’empreinte est déterministe et fait 64 caractères hexadécimaux', () => {
    expect(of(OUR_DM.id)).toMatch(/^[0-9a-f]{64}$/);
    expect(of(OUR_DM.id)).toBe(of(OUR_DM.id));
  });

  it('elle ne dépend ni du texte, ni du rang d’occurrence, ni de l’ordre de lecture', () => {
    const direct = read(payload({ messages: [OUR_DM, THEIR_REPLY] }));
    const reversed = read(payload({ messages: [THEIR_REPLY, OUR_DM] }));
    const edited = read(payload({ messages: [OUR_DM, { ...THEIR_REPLY, text: 'texte différent' }] }));

    const fingerprints = (result: ReturnType<typeof read>): string[] =>
      result.messages.map((message) => of(message.providerMessageId));

    expect(fingerprints(direct)).toEqual(fingerprints(reversed));
    expect(fingerprints(direct)).toEqual(fingerprints(edited));
  });

  it('deux messages différents ne partagent pas d’identité', () => {
    expect(of(OUR_DM.id)).not.toBe(of(THEIR_REPLY.id));
  });

  it('le même identifiant natif dans un autre fil est une autre identité', () => {
    expect(of(OUR_DM.id)).not.toBe(of(OUR_DM.id, OTHER_THREAD));
  });

  it('la recette porte sa version, pour qu’un changement soit une décision', () => {
    expect(NETWORK_MESSAGE_FINGERPRINT_VERSION).toBe('ig-dm-net-v1');
    const expected = createHash('sha256')
      .update([NETWORK_MESSAGE_FINGERPRINT_VERSION, ACCOUNT, THREAD, OUR_DM.id].join(' '), 'utf8')
      .digest('hex');
    expect(of(OUR_DM.id)).toBe(expected);
  });

  it('le même corps lu deux fois rend exactement les mêmes identités', () => {
    const body = payload({ messages: [OUR_DM, THEIR_REPLY] });
    expect(read(body).messages).toEqual(read(body).messages);
  });

  it('un identifiant répété dans la même réponse ne compte qu’une fois', () => {
    const result = read(payload({ messages: [OUR_DM, OUR_DM] }));
    expect(result.messages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §10 — rien du corps brut ne survit à la lecture
// ---------------------------------------------------------------------------

describe('IG5 R3 §10 — la réponse GraphQL n’est jamais conservée', () => {
  it('la lecture ne rend que des champs nommés, jamais le corps', () => {
    const body = payload({ messages: [OUR_DM, THEIR_REPLY] });
    const result = read(body);

    expect(Object.keys(result).sort()).toEqual(
      ['detail', 'identity', 'isGroup', 'messages', 'participants', 'readable', 'rejected', 'threadKey'].sort(),
    );
    for (const message of result.messages) {
      expect(Object.keys(message).sort()).toEqual(
        ['contentKind', 'providerMessageId', 'senderUsername', 'text', 'timestampMs'].sort(),
      );
    }
    // Rien de ce qui sort ne contient le corps, ni un fragment d'enveloppe.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('get_slide_thread_nullable');
    expect(serialized).not.toContain('__typename');
    expect(serialized).not.toContain('sender_fbid');
    expect(serialized.length).toBeLessThan(body.length);
  });

  it('le module ne sait ni écrire, ni appeler le réseau', () => {
    for (const forbidden of ['fetch(', 'HttpClient', 'writeFile', 'page.', 'logger', 'sql.']) {
      expect(executableSourceOf('src/lib/instagram/threadDetailNetwork.ts')).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// §9 — les gardes, inchangées
// ---------------------------------------------------------------------------

describe('IG5 R3 §9 — ce que la garde laisse passer, et ce qu’elle refuse toujours', () => {
  const graphql = (operation: string): { url: string; method: string; postData: string } => ({
    url: `https://www.instagram.com${THREAD_DETAIL_PATH}`,
    method: 'POST',
    postData: `fb_api_req_friendly_name=${operation}&variables=%7B%7D`,
  });

  it('IGDThreadDetailQuery passe sous la règle GÉNÉRALE de lecture, sans être nommée', () => {
    const decision = classifyAdjudicationRequest(graphql('IGDThreadDetailQuery'));
    expect(decision.allowed).toBe(true);
    // `read_only_endpoint` et non une exception : rien n'a été ajouté pour elle.
    expect(decision.allowed && decision.rule).toBe('read_only_endpoint');
  });

  it('l’envoi d’un DM reste refusé', () => {
    const decision = classifyAdjudicationRequest(graphql('IGDirectTextSendMutation'));
    expect(decision.allowed).toBe(false);
    expect(!decision.allowed && decision.rule).toBe('graphql_effect');
  });

  it('marquer un fil comme lu reste refusé, dans ses deux formes', () => {
    for (const operation of ['useIGDMarkThreadAsReadMutation', 'useIGDMarkThreadAsReadValidationMutation']) {
      const decision = classifyAdjudicationRequest(graphql(operation));
      expect(decision.allowed).toBe(false);
      expect(!decision.allowed && decision.rule).toBe('graphql_effect');
    }
  });

  it('une mutation que personne n’a encore vue est refusée sans être nommée', () => {
    const decision = classifyAdjudicationRequest(graphql('IGDSomethingEntirelyNewMutation'));
    expect(decision.allowed).toBe(false);
  });

  it('la liste d’écoute n’autorise rien : elle ne fait que choisir ce qu’on lit', () => {
    expect(THREAD_DETAIL_OPERATIONS).toEqual(['IGDThreadDetailQuery']);
    // Une opération voisine n'est pas écoutée : c'est une égalité, pas un motif.
    expect(isThreadDetailResponse({ path: THREAD_DETAIL_PATH, friendlyName: 'IGDThreadDetailQueryV2', status: 200 })).toBe(
      false,
    );
    expect(isThreadDetailResponse({ path: THREAD_DETAIL_PATH, friendlyName: 'IGDThreadDetailQuery', status: 200 })).toBe(
      true,
    );
    // Ni un statut d'erreur, ni un autre chemin.
    expect(isThreadDetailResponse({ path: THREAD_DETAIL_PATH, friendlyName: 'IGDThreadDetailQuery', status: 500 })).toBe(
      false,
    );
    expect(isThreadDetailResponse({ path: '/api/v1/direct_v2/', friendlyName: 'IGDThreadDetailQuery', status: 200 })).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// §9 — chooseThreadScope n'a pas été touchée
// ---------------------------------------------------------------------------

describe('IG5 R3 §9 — chooseThreadScope est laissée exactement où elle était', () => {
  /** La chaîne qui a produit le blocage de R2 : le composeur, puis un wrapper. */
  const chain = [
    {
      index: 0,
      tag: 'div',
      role: null,
      ariaLabel: null,
      rect: { left: 100, right: 852, top: 790, bottom: 834 },
      textBearingOutsideComposer: 5,
      heightRatio: 1,
      isDocumentRoot: false,
    },
    {
      index: 1,
      tag: 'div',
      role: null,
      ariaLabel: null,
      rect: { left: 100, right: 852, top: 746, bottom: 834 },
      textBearingOutsideComposer: 5,
      heightRatio: 2,
      isDocumentRoot: false,
    },
  ];

  it('rend le même verdict qu’avant cette mission — le niveau 1, ses seuils inchangés', () => {
    const scope = chooseThreadScope(chain);
    expect(scope.kind).not.toBe('none');
    expect(scope.level).toBe(1);
    expect(scope.rect).toEqual(chain[1]?.rect);
  });

  it('une chaîne vide ne retient toujours aucun périmètre', () => {
    expect(chooseThreadScope([]).kind).toBe('none');
  });

  it('le lecteur réseau ne s’en sert pas, et ne l’importe pas', () => {
    // C'est la garantie structurelle de §9 : le nouveau chemin ne peut pas
    // faire régresser la preuve de remise, parce qu'il ne passe pas par elle.
    //
    // L'assertion porte sur le CODE, pas sur le fichier : les commentaires du
    // module expliquent longuement pourquoi `chooseThreadScope` n'est pas
    // touchée, et une recherche naïve trouverait cette explication-là.
    const code = executableSourceOf('src/lib/instagram/threadDetailNetwork.ts');
    expect(code).not.toContain('chooseThreadScope');
    expect(code).not.toContain('deliveryProof');
    expect(code).not.toContain('ThreadHarvest');
  });
});
