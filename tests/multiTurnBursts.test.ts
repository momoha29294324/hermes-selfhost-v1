import { describe, expect, it } from 'vitest';
import {
  BURST_GAP_MS,
  BURST_MAX_CHARS,
  BURST_MAX_MESSAGES,
  burstContaining,
  burstSettled,
  closesBurst,
  currentUtterance,
  groupInboundBursts,
} from '@/lib/conversation/burst';
import { readSignals } from '@/lib/conversation/signals';
import type { ConversationThread, ConversationTurn } from '@/lib/conversation/thread';
import { firstEscalatingDemand, readCommercialDemands } from '@/lib/conversation/commercialPolicy';
import { detectUnsubscribeDemand } from '@/lib/replies/taxonomy';
import { resolvePriceSubject } from '@/lib/sales/priceSubject';

/**
 * HERMES-MULTI-TURN-BURSTS-R1 — plusieurs bulles, UNE prise de parole.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce fichier éprouve
 * ---------------------------------------------------------------------------
 * Un humain sur Instagram n'écrit pas un paragraphe. Il écrit « ouais », puis
 * « j'avais essayé », puis « mais ça marchait pas », puis « et ils
 * disparaissaient au prix ». Quatre lignes en base, une seule phrase.
 *
 * Le dépôt savait les GROUPER pour décider QUAND répondre depuis
 * HERMES-CONVERSATION-R2 (`burstSettled`, `closesBurst`). Il ne savait pas les
 * grouper pour décider SUR QUOI raisonner : `burstText` n'avait AUCUN appelant
 * de production, et tout ce qui lit réellement le message — lexique commercial,
 * sujet du prix, demande d'arrêt, cadre d'énonciation — recevait la DERNIÈRE
 * BULLE seule.
 *
 * Ce fichier est PUR : aucune base, aucun modèle, aucune horloge implicite.
 * C'est ce qui permet de le rejouer entièrement à chaque `npm run validate` —
 * un corpus sémantique qui coûte un appel de modèle ne se rejoue jamais.
 *
 * ---------------------------------------------------------------------------
 * Ce qu'il n'éprouve PAS, et pourquoi
 * ---------------------------------------------------------------------------
 * Il ne vérifie aucune catégorie rendue par le modèle. Ce qui DÉCIDE reste du
 * code et reste APRÈS le modèle ; c'est ce code-là qu'on éprouve ici, sur le
 * texte que l'agrégation produit.
 */

const T0 = Date.parse('2026-08-23T13:13:00.000Z');

function turn(
  offsetMs: number,
  text: string,
  direction: 'INBOUND' | 'OUTBOUND' = 'INBOUND',
  exposed = true,
): ConversationTurn {
  return Object.freeze({
    direction,
    provenance:
      direction === 'INBOUND'
        ? ('inbound_message' as const)
        : exposed
          ? ('sent_autonomous_reply' as const)
          : ('human_approved_reply' as const),
    at: new Date(T0 + offsetMs).toISOString(),
    text,
    sourceId: `m-${String(offsetMs)}`,
    classification: null,
    exposed,
  });
}

/** Le texte du tour logique qui se termine par la dernière bulle donnée. */
function utteranceOf(turns: readonly ConversationTurn[]): string {
  const inbound = turns.filter((entry) => entry.direction === 'INBOUND');
  const last = inbound[inbound.length - 1];
  if (last === undefined) throw new Error('aucun message entrant');
  return currentUtterance(turns, last.sourceId, last.text).text;
}

function emptyThread(turns: readonly ConversationTurn[], currentId: string): ConversationThread {
  const inbound = turns.filter((entry) => entry.direction === 'INBOUND');
  return Object.freeze({
    turns: Object.freeze([...turns]),
    inboundTurns: Object.freeze(inbound),
    outboundTurns: Object.freeze(turns.filter((entry) => entry.direction === 'OUTBOUND')),
    exposedOutboundTurns: Object.freeze(
      turns.filter((entry) => entry.direction === 'OUTBOUND' && entry.exposed),
    ),
    currentInboundId: currentId,
    priorInboundCount: 0,
    channel: 'instagram_dm',
    truncated: false,
    prospectId: 'p-1',
  });
}

// ---------------------------------------------------------------------------
// 1. Les BASES : de une à cinq bulles
// ---------------------------------------------------------------------------

describe('§1 — la taille d’une prise de parole', () => {
  it('un message seul est une salve d’un message, et son texte est rendu TEL QUEL', () => {
    const turns = [turn(0, 'ouais')];
    const bursts = groupInboundBursts(turns);
    expect(bursts).toHaveLength(1);
    expect(bursts[0]?.messageIds).toEqual(['m-0']);

    // Le texte du fil est écrêté (`MAX_REPLY_BODY_CHARS`) ; celui de la base ne
    // l'est pas. Un message seul doit rendre le corps de la base au caractère
    // près, sans quoi ce round aurait changé en silence ce que le modèle lit
    // d'un message ORDINAIRE — c'est-à-dire de tout le corpus existant.
    const single = currentUtterance(turns, 'm-0', 'le corps venu de la base');
    expect(single.text).toBe('le corps venu de la base');
    expect(single.aggregated).toBe(false);
    expect(single.messageIds).toEqual(['m-0']);
  });

  it('deux bulles forment UNE salve', () => {
    const turns = [turn(0, 'ouais'), turn(3_000, 'j’avais essayé')];
    const bursts = groupInboundBursts(turns);
    expect(bursts).toHaveLength(1);
    expect(bursts[0]?.messageIds).toEqual(['m-0', 'm-3000']);
    expect(utteranceOf(turns)).toBe('ouais\nj’avais essayé');
  });

  it('trois bulles forment UNE salve, et seule la dernière la clôt', () => {
    const turns = [turn(0, 'ouais'), turn(3_000, 'j’avais essayé'), turn(9_000, 'mais ça marchait pas')];
    const burst = burstContaining(turns, 'm-9000');
    expect(burst).not.toBeNull();
    expect(burst?.messageIds).toEqual(['m-0', 'm-3000', 'm-9000']);
    expect(closesBurst(burst!, 'm-9000')).toBe(true);
    expect(closesBurst(burst!, 'm-3000')).toBe(false);
    expect(closesBurst(burst!, 'm-0')).toBe(false);
  });

  it('cinq bulles forment UNE salve, dans l’ordre d’écriture', () => {
    const turns = [
      turn(0, 'ouais'),
      turn(2_000, 'j’avais essayé'),
      turn(5_000, 'mais ça marchait pas'),
      turn(8_000, 'j’avais surtout des curieux'),
      turn(12_000, 'et ils disparaissaient au prix'),
    ];
    const bursts = groupInboundBursts(turns);
    expect(bursts).toHaveLength(1);
    expect(bursts[0]?.turns).toHaveLength(5);
    expect(utteranceOf(turns)).toBe(
      'ouais\nj’avais essayé\nmais ça marchait pas\nj’avais surtout des curieux\net ils disparaissaient au prix',
    );
  });

  it('l’ordre et les horodatages sont CONSERVÉS — rien n’est réordonné ni fusionné', () => {
    const turns = [turn(0, 'un'), turn(1_000, 'deux'), turn(2_000, 'trois')];
    const burst = burstContaining(turns, 'm-2000');
    expect(burst?.messageIds).toEqual(['m-0', 'm-1000', 'm-2000']);
    expect(burst?.startedAt).toBe(new Date(T0).toISOString());
    expect(burst?.endedAt).toBe(new Date(T0 + 2_000).toISOString());
    // Les tours d'origine sont intacts : la salve les CITE, elle ne les remplace pas.
    expect(burst?.turns.map((entry) => entry.text)).toEqual(['un', 'deux', 'trois']);
  });
});

// ---------------------------------------------------------------------------
// 2. Les BORNES — une salve ne peut pas devenir un fil
// ---------------------------------------------------------------------------

describe('§2 — ce qui BORNE une salve', () => {
  it('le silence sépare deux prises de parole', () => {
    const turns = [turn(0, 'ouais'), turn(BURST_GAP_MS + 1_000, 'finalement je suis intéressé')];
    const bursts = groupInboundBursts(turns);
    expect(bursts).toHaveLength(2);
    // Le tour logique du second message ne porte PAS le premier.
    expect(currentUtterance(turns, `m-${String(BURST_GAP_MS + 1_000)}`, 'finalement je suis intéressé').text).toBe(
      'finalement je suis intéressé',
    );
  });

  it('un message DIFFÉRÉ au-delà du seuil n’est jamais recollé à l’aveugle', () => {
    // Une heure plus tard : la personne est revenue, ce n'est pas la même phrase.
    const turns = [turn(0, 'j’avais des leads'), turn(3_600_000, 'et sinon vous faites quoi ?')];
    expect(groupInboundBursts(turns)).toHaveLength(2);
  });

  it('le NOMBRE de bulles borne la salve, et la plus récente reste complète', () => {
    const turns = Array.from({ length: BURST_MAX_MESSAGES + 3 }, (_, index) =>
      turn(index * 1_000, `bulle ${String(index)}`),
    );
    const bursts = groupInboundBursts(turns);
    expect(bursts.length).toBeGreaterThan(1);
    for (const burst of bursts) expect(burst.turns.length).toBeLessThanOrEqual(BURST_MAX_MESSAGES);
    // La borne coupe en REPARTANT au message qui dépasse : la salve qui porte le
    // dernier tour est donc complète de son côté récent, et le message auquel on
    // répond n'est jamais masqué par une borne.
    const last = bursts[bursts.length - 1];
    expect(last?.lastSourceId).toBe(`m-${String((BURST_MAX_MESSAGES + 2) * 1_000)}`);
  });

  it('la TAILLE borne la salve — et un message seul n’est jamais tronqué', () => {
    const long = 'x'.repeat(BURST_MAX_CHARS + 500);
    const turns = [turn(0, 'court'), turn(1_000, long)];
    const bursts = groupInboundBursts(turns);
    expect(bursts).toHaveLength(2);
    // Le message trop long est sa PROPRE salve, entier.
    expect(bursts[1]?.turns[0]?.text).toHaveLength(BURST_MAX_CHARS + 500);
  });

  it('un horodatage illisible ne coupe pas : « je n’ai pas su comparer » n’est pas « elle est revenue »', () => {
    const broken: ConversationTurn = Object.freeze({
      direction: 'INBOUND' as const,
      provenance: 'inbound_message' as const,
      at: 'pas-une-date',
      text: 'et sinon ?',
      sourceId: 'm-broken',
      classification: null,
      exposed: true,
    });
    expect(groupInboundBursts([turn(0, 'ouais'), broken])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. La FRONTIÈRE de notre propre réponse
// ---------------------------------------------------------------------------

describe('§3 — ce que Hermes a dit ferme la prise de parole précédente', () => {
  it('après une réponse REMISE, le message suivant est un tour NEUF — jamais recollé en arrière', () => {
    const turns = [
      turn(0, 'j’avais des leads'),
      turn(30_000, 'mais surtout des curieux'),
      turn(60_000, 'Tu les relançais comment ?', 'OUTBOUND'),
      turn(90_000, 'je les relançais pas vraiment'),
    ];
    const bursts = groupInboundBursts(turns);
    expect(bursts).toHaveLength(2);
    expect(bursts[0]?.messageIds).toEqual(['m-0', 'm-30000']);
    expect(bursts[1]?.messageIds).toEqual(['m-90000']);

    // Le tour logique du dernier message ne contient RIEN de ce qui précède
    // notre réponse : ces messages-là ont déjà été traités.
    expect(currentUtterance(turns, 'm-90000', 'je les relançais pas vraiment').text).toBe(
      'je les relançais pas vraiment',
    );
  });

  it('trois secondes après notre réponse suffisent : c’est la remise qui coupe, pas l’horloge', () => {
    // Le cas que l'ancienne règle ratait. L'espacement minimal de la coquille
    // est à ZÉRO et le rail autonome écrit en quelques secondes : sous l'écart
    // de silence de cinq minutes, ces deux messages étaient collés en UNE
    // phrase, de part et d'autre d'une réponse déjà partie.
    const turns = [
      turn(0, 'ok'),
      turn(2_000, 'et ça marche vraiment ?', 'OUTBOUND'),
      turn(5_000, 'oui enfin je crois'),
    ];
    const bursts = groupInboundBursts(turns);
    expect(bursts).toHaveLength(2);
  });

  it('un brouillon JAMAIS REMIS ne coupe rien — il n’a interrompu personne', () => {
    const turns = [
      turn(0, 'ouais'),
      turn(2_000, 'texte validé, jamais envoyé', 'OUTBOUND', false),
      turn(5_000, 'j’avais essayé'),
    ];
    const bursts = groupInboundBursts(turns);
    expect(bursts).toHaveLength(1);
    expect(bursts[0]?.messageIds).toEqual(['m-0', 'm-5000']);
  });
});

// ---------------------------------------------------------------------------
// 4. La SÉMANTIQUE composée — le cœur du round
// ---------------------------------------------------------------------------

describe('§4 — ce qu’une prise de parole éclatée VEUT DIRE', () => {
  it('fragmentation naturelle : le tour logique porte la phrase entière', () => {
    const turns = [turn(0, 'ouais'), turn(2_000, 'j’avais essayé'), turn(6_000, 'mais ça marchait pas')];
    expect(utteranceOf(turns)).toBe('ouais\nj’avais essayé\nmais ça marchait pas');
  });

  /**
   * Le cas RÉEL du 23 août 2026, éclaté en bulles.
   *
   * « ils demandaient » / « le prix » / « puis répondaient plus » raconte ce que
   * les clients DU PROSPECT faisaient. Personne ne nous demande un prix — c'est
   * au contraire l'information exacte qu'une prospection cherche à obtenir.
   *
   * Recomposé, le cadre d'énonciation reste RAPPORTÉ, donc aucune escalade de
   * prix. C'est `utteranceScope` (R12) qui le tient ; ce test vérifie que
   * l'agrégation ne le CASSE pas — un fragment isolé (« le prix ») n'a aucun
   * sujet grammatical, et c'est précisément ce qui rendait la lecture fausse.
   */
  it('composition commerciale : un prix RAPPORTÉ ne devient pas une demande courante', () => {
    const turns = [
      turn(0, 'ils demandaient'),
      turn(2_000, 'le prix'),
      turn(5_000, 'puis répondaient plus'),
    ];
    const text = utteranceOf(turns);
    expect(text).toBe('ils demandaient\nle prix\npuis répondaient plus');

    const price = resolvePriceSubject(text);
    expect(price.subject).not.toBe('POST_TRIAL_PRICE');
    expect(price.subject).toBe('UNRESOLVED');

    // Et aucune demande commerciale ESCALADANTE n'en sort.
    expect(firstEscalatingDemand(readCommercialDemands(text))).toBeNull();
  });

  /**
   * L'OPPOSÉ dangereux, et il doit rester fermé.
   *
   * Ici la personne nous demande vraiment ce que ça coûte APRÈS l'essai — le
   * seul prix que ce dépôt n'a pas. Lue sur la dernière bulle seule (« ça coûte
   * combien ? »), l'ancre d'essai disparaissait et le sujet sortait en
   * `UNRESOLVED` : le refus restait le bon, son MOTIF était faux.
   */
  it('l’opposé : « après les 7 jours » + « ça coûte combien ? » est une demande COURANTE, et elle escalade', () => {
    const turns = [turn(0, 'ok'), turn(2_000, 'mais toi après les 7 jours'), turn(5_000, 'ça coûte combien ?')];
    const text = utteranceOf(turns);

    const price = resolvePriceSubject(text);
    expect(price.subject).toBe('POST_TRIAL_PRICE');
    // Fail-closed : aucune vérité de ce dépôt ne couvre ce prix.
    expect(price.covered).toBe(false);

    // La dernière bulle SEULE ne suffisait pas à nommer le sujet.
    expect(resolvePriceSubject('ça coûte combien ?').subject).not.toBe('POST_TRIAL_PRICE');
  });

  it('question mixte : la question COURANTE survit à la bulle qui la précède', () => {
    const turns = [turn(0, 'j’avais surtout des curieux'), turn(4_000, 'et toi tu fais quoi différemment ?')];
    const text = utteranceOf(turns);
    expect(text).toBe('j’avais surtout des curieux\net toi tu fais quoi différemment ?');

    const signals = readSignals(text, 'QUESTION', emptyThread(turns, 'm-4000'));
    // La question est LUE — elle n'est pas noyée par le récit qui la précède.
    expect(signals.questionTopic).not.toBeNull();
    expect(signals.questionTopic).not.toBe('OTHER_QUESTION');
  });

  /**
   * La demande d'ARRÊT éclatée sur deux bulles.
   *
   * C'est le cas où l'agrégation n'est pas un confort mais une SÉCURITÉ : lue
   * sur la dernière bulle seule, une volonté d'arrêt exprimée dans la première
   * était perdue. `detectUnsubscribeDemand` reçoit désormais le tour logique
   * entier, dans les deux ordres.
   */
  it('arrêt éclaté : la demande est lue quelle que soit la bulle qui la porte', () => {
    const first = [turn(0, 'laisse tomber'), turn(3_000, 'me recontacte pas')];
    expect(detectUnsubscribeDemand(utteranceOf(first))).not.toBeNull();

    // Et dans l'ordre inverse — le mot décisif dans la PREMIÈRE bulle, la
    // dernière étant anodine. C'est celui-là que la lecture mono-bulle ratait.
    const second = [turn(0, 'me recontacte pas'), turn(3_000, 'merci quand même')];
    expect(detectUnsubscribeDemand('merci quand même')).toBeNull();
    expect(detectUnsubscribeDemand(utteranceOf(second))).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. La COURSE — un message qui arrive pendant qu'on rédige
// ---------------------------------------------------------------------------

describe('§5 — un message arrivé depuis rend la lecture périmée', () => {
  it('A+B lus, puis C arrive : B ne clôt plus la salve, donc B est dépassé', () => {
    const withoutC = [turn(0, 'A'), turn(2_000, 'B')];
    expect(closesBurst(burstContaining(withoutC, 'm-2000')!, 'm-2000')).toBe(true);

    const withC = [...withoutC, turn(4_000, 'C')];
    // La MÊME question, reposée sur le fil à jour, rend l'inverse. C'est ce que
    // le crochet pré-effet relit avant tout effet (`PLAN_STALE`), et c'est ce
    // qui empêche un texte calculé sur A+B de partir après l'arrivée de C.
    expect(closesBurst(burstContaining(withC, 'm-2000')!, 'm-2000')).toBe(false);
    expect(closesBurst(burstContaining(withC, 'm-4000')!, 'm-4000')).toBe(true);
  });

  it('le tour logique RECONSTRUIT sur A+B+C porte les trois — jamais C seul', () => {
    const turns = [turn(0, 'A'), turn(2_000, 'B'), turn(4_000, 'C')];
    expect(currentUtterance(turns, 'm-4000', 'C').text).toBe('A\nB\nC');
  });

  it('le tour logique ne regarde JAMAIS devant lui', () => {
    // Rejouer un ancien message ne doit pas lui faire porter ce qui l'a suivi :
    // c'est la leçon de HERMES-SEMANTIC-GROUNDING-R1, appliquée à l'agrégation.
    const turns = [turn(0, 'A'), turn(2_000, 'B'), turn(4_000, 'C')];
    expect(currentUtterance(turns, 'm-2000', 'B').text).toBe('A\nB');
    expect(currentUtterance(turns, 'm-0', 'A').text).toBe('A');
  });

  it('tant que le silence n’est pas établi, la salve reste ouverte', () => {
    const turns = [turn(0, 'A'), turn(2_000, 'B')];
    const burst = burstContaining(turns, 'm-2000')!;
    expect(burstSettled(burst, new Date(T0 + 60_000), 300_000)).toBe(false);
    expect(burstSettled(burst, new Date(T0 + 400_000), 300_000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. DÉTERMINISME et absence d'exception nominative
// ---------------------------------------------------------------------------

describe('§6 — déterminisme et portée', () => {
  it('la reconstruction est déterministe : mêmes entrées, mêmes identifiants', () => {
    const turns = [turn(0, 'un'), turn(1_000, 'deux'), turn(2_000, 'trois')];
    const a = currentUtterance(turns, 'm-2000', 'trois');
    const b = currentUtterance(turns, 'm-2000', 'trois');
    expect(a.text).toBe(b.text);
    expect(a.messageIds).toEqual(b.messageIds);
    expect(a.messageIds).toEqual(['m-0', 'm-1000', 'm-2000']);
  });

  it('AUCUNE exception coquille : le découpage ne reçoit ni prospect, ni compte, ni configuration', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/lib/conversation/burst.ts', 'utf8'),
    );
    // Il n'existe aucune donnée depuis laquelle une exception pourrait être
    // écrite : la signature ne voit qu'un fil, un identifiant et un texte.
    expect(source).not.toContain('controlledSelfTest');
    expect(source).not.toContain('operator_second_account');
    expect(source).not.toContain('shellProspectId');
  });

  it('une salve ne traverse jamais deux conversations : elle se lit sur UN fil', () => {
    // `groupInboundBursts` ne reçoit que les tours d'un fil, chargé pour un
    // prospect. Aucun chemin ne lui donne deux conversations, et la fonction
    // n'a aucun moyen d'en demander une seconde : elle est pure.
    const turns = [turn(0, 'un'), turn(1_000, 'deux')];
    const burst = burstContaining(turns, 'm-0');
    expect(burst?.messageIds.every((id) => turns.some((entry) => entry.sourceId === id))).toBe(true);
  });
});
