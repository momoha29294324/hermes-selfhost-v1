import { describe, expect, it } from 'vitest';
import {
  checkNaturalness,
  computeLengthBudget,
  concreteAnchors,
  classifyRebound,
  measureDraft,
  renderCorrections,
  renderLengthDirective,
  type NaturalnessCode,
  type NaturalnessInput,
} from '@/lib/conversation/naturalness';
import { buildStyleProfile, type StyleProfile } from '@/lib/conversation/style';
import type { ConversationSignals } from '@/lib/conversation/signals';
import type { ConversationGoal, ConversationState, CoveredTopic } from '@/lib/conversation/state';
import { CONVERSATION_FRAME, renderStyleDirective } from '@/lib/conversation/voice';

/**
 * CONVERSATION-R1.1 §27 — la naturalité, vérifiée là où elle est décidable.
 *
 * Aucun modèle n'intervient dans ce fichier, et c'est le point. « La réponse
 * est-elle naturelle ? » n'est pas testable sur une sortie de modèle sans
 * devenir une espérance statistique. Ce qui est testable, et ce qui GOUVERNE
 * réellement la réponse, c'est le contrat que le code contrôle : le budget de
 * longueur, le compte de questions, l'ouverture, le rebond, le registre.
 *
 * Les textes sont fictifs, sauf là où c'est explicitement dit — et là où ça
 * l'est, seul le message reçu est réel, jamais l'identité qui l'a écrit.
 */

// ---------------------------------------------------------------------------
// Outillage
// ---------------------------------------------------------------------------

function style(...texts: readonly string[]): StyleProfile {
  return buildStyleProfile(
    texts.map((text, index) => ({
      text,
      at: new Date(Date.UTC(2026, 7, 20, 9 + index, 0, 0)).toISOString(),
    })),
  );
}

const BASE_SIGNALS: ConversationSignals = Object.freeze({
  questionTopic: 'NONE',
  objectionTopic: 'NONE',
  buyingSignal: 'WEAK',
  callReadiness: 'LOW',
  sensitiveFlags: Object.freeze([]),
  explicitCallRequest: false,
  tooShortToRead: false,
});

function signals(overrides: Partial<ConversationSignals> = {}): ConversationSignals {
  return Object.freeze({ ...BASE_SIGNALS, ...overrides });
}

function state(
  goal: ConversationGoal,
  covered: readonly CoveredTopic[] = [],
): ConversationState {
  return Object.freeze({
    prospectId: 'p1',
    counterparty: 'ACME',
    channel: 'instagram_dm',
    lastInboundAt: null,
    lastOutboundAt: null,
    inboundTurnCount: 1,
    outboundTurnCount: 1,
    isFirstReply: true,
    goal,
    qualification: 'ENGAGED',
    coveredTopics: Object.freeze([...covered]),
    questionsAskedByUs: 1,
    questionTopicsReceived: Object.freeze([]),
    objectionsEncountered: Object.freeze([]),
    nextAction: 'HUMAN_REPLY_NOW',
    followUpStillRelevant: true,
    humanNeeded: false,
  });
}

interface CheckOptions {
  readonly inbound?: string;
  readonly style?: StyleProfile;
  readonly goal?: ConversationGoal;
  readonly covered?: readonly CoveredTopic[];
  readonly signals?: ConversationSignals;
  readonly channel?: 'email' | 'instagram_dm';
  readonly previous?: readonly string[];
}

function check(body: string, options: CheckOptions = {}) {
  const input: NaturalnessInput = {
    body,
    lastInboundText: options.inbound ?? 'Bonjour, principalement mon site internet ainsi que ma fiche Google',
    style: options.style ?? style('Bonjour, principalement mon site internet ainsi que ma fiche Google'),
    state: state(options.goal ?? 'QUALIFY_LIGHTLY', options.covered ?? []),
    signals: options.signals ?? signals(),
    channel: options.channel ?? 'instagram_dm',
    previousOutboundTexts: options.previous ?? [],
  };
  return checkNaturalness(input);
}

function codes(body: string, options: CheckOptions = {}): NaturalnessCode[] {
  return check(body, options).findings.map((finding) => finding.code);
}

// ---------------------------------------------------------------------------
// §27.1 / §7 — la longueur suit celle d'en face
// ---------------------------------------------------------------------------

describe('§27.1 — une réponse brève appelle une réponse brève', () => {
  it('resserre le budget quand ils écrivent trois mots', () => {
    const tight = computeLengthBudget('ouais pk pas', 'instagram_dm');
    const loose = computeLengthBudget(
      'Bonjour, merci de votre message. Nous travaillons principalement avec une clientèle locale ' +
        'fidélisée depuis plusieurs années et nous nous interrogeons sur la pertinence d’un canal ' +
        'complémentaire, sans avoir encore tranché la question du budget à y consacrer cette année.',
      'instagram_dm',
    );
    expect(tight.band).toBe('VERY_SHORT');
    expect(loose.band).toBe('LONG');
    expect(tight.maxChars).toBeLessThan(loose.maxChars);
    expect(tight.maxSentences).toBeLessThanOrEqual(2);
  });

  it('accepte huit mots comme une réponse entière', () => {
    // §7 : « un excellent message peut faire 8 à 20 mots ».
    const report = check('Tu cherches surtout à avoir plus de demandes en ce moment ?', {
      inbound: 'ouais pk pas',
      style: style('ouais pk pas', 'tu fais quoi comme pubs ?'),
    });
    expect(report.metrics.words).toBeLessThanOrEqual(20);
    expect(report.verdict).toBe('NATURAL');
  });

  it('refuse un pavé en réponse à une ligne', () => {
    const paragraph =
      'Merci beaucoup pour cette réponse très complète. De notre côté, nous travaillons avec des ' +
      'professionnels du secteur depuis plusieurs années et nous mettons en place des campagnes ' +
      'ciblées qui permettent de générer des demandes entrantes de façon régulière. Je serais ravi ' +
      'de vous en dire davantage si le sujet vous intéresse.';
    expect(codes(paragraph, { inbound: 'ouais pk pas' })).toContain('TOO_LONG');
    expect(check(paragraph, { inbound: 'ouais pk pas' }).verdict).toBe('UNNATURAL');
  });

  it('refuse quatre phrases quand deux suffisent', () => {
    const four = 'Bonne question. On regarde ça. C’est faisable. Vous voulez qu’on avance ?';
    expect(codes(four, { inbound: 'ok' })).toContain('TOO_MANY_SENTENCES');
  });
});

// ---------------------------------------------------------------------------
// §27.2 / §8 — une seule question
// ---------------------------------------------------------------------------

describe('§27.2 / §27.26 — une seule vraie question par message', () => {
  it('laisse passer une question', () => {
    expect(codes('Et ça vous apporte déjà des demandes régulièrement ?')).not.toContain('MULTIPLE_QUESTIONS');
  });

  it('attrape deux questions dans le même message', () => {
    const two = 'Ça vous apporte des demandes ? Et vous cherchez à développer ?';
    expect(codes(two)).toContain('MULTIPLE_QUESTIONS');
  });

  it('attrape l’empilement question + pitch + appel', () => {
    const stacked =
      'On aide les pros du atelier à avoir des demandes régulières, et le budget dépend du périmètre — ' +
      'vous voulez qu’on s’appelle ?';
    const found = codes(stacked, { inbound: 'ok et vous faites quoi exactement ?' });
    expect(found).toContain('TOO_MANY_INTENTS');
  });
});

// ---------------------------------------------------------------------------
// §27.3 / §27.4 / §9 / §10 — l'ouverture
// ---------------------------------------------------------------------------

describe('§27.3 / §27.4 — pas d’accusé de réception automatique', () => {
  it('bloque « Merci pour votre retour » quand la conversation continue', () => {
    const found = codes('Merci pour votre retour ! Et ça vous apporte des demandes ?');
    expect(found).toContain('GENERIC_OPENING');
    expect(check('Merci pour votre retour ! Et ça vous apporte des demandes ?').verdict).toBe('UNNATURAL');
  });

  it('bloque « Je vois » en préfixe', () => {
    expect(codes('Je vois, et aujourd’hui ça vous apporte des demandes ?')).toContain('GENERIC_OPENING');
  });

  it('bloque aussi « Effectivement », « Dans ce cas » et « Permettez-moi »', () => {
    for (const opening of [
      'Effectivement, c’est souvent le cas.',
      'Dans ce cas, on peut regarder ça.',
      'Permettez-moi de vous poser une question.',
    ]) {
      expect(codes(opening)).toContain('GENERIC_OPENING');
    }
  });

  it('n’en fait qu’un signalement quand le tour appelle vraiment un accusé de réception', () => {
    // §9 : ces formulations ne sont pas lexicalement interdites. Face à un
    // report, remercier et refermer est exactement ce qu'il faut faire.
    const report = check('Merci de votre retour, je vous relance plus tard alors.', {
      goal: 'ACKNOWLEDGE_AND_CLOSE',
      inbound: 'pas maintenant',
    });
    expect(report.findings.map((finding) => finding.code)).toContain('GENERIC_OPENING');
    expect(report.findings.find((finding) => finding.code === 'GENERIC_OPENING')?.severity).toBe('WARNING');
    expect(report.verdict).toBe('ACCEPTABLE');
  });

  it('laisse passer une réponse qui entre dans le vif', () => {
    expect(check('Et ça vous ramène déjà régulièrement des demandes ou pas vraiment ?').verdict).toBe('NATURAL');
  });
});

// ---------------------------------------------------------------------------
// §27.27 / §21 — la diversité
// ---------------------------------------------------------------------------

describe('§27.27 / §21 — un gabarit qui se répète est détecté', () => {
  it('refuse la même famille d’ouverture deux fois dans un fil', () => {
    const found = codes('Merci pour ces précisions, on peut regarder ça.', {
      goal: 'ACKNOWLEDGE_AND_CLOSE',
      previous: ['Merci pour votre retour, je note.'],
    });
    expect(found).toContain('OPENING_ALREADY_USED');
  });

  it('refuse les trois mêmes premiers mots qu’un tour précédent', () => {
    const found = codes('Et aujourd’hui vous arrivez à tenir le rythme ?', {
      previous: ['Et aujourd’hui ça vous apporte des demandes ?'],
    });
    expect(found).toContain('TEMPLATE_REPEATED');
  });

  it('ne pénalise pas deux réponses simplement différentes', () => {
    const found = codes('Et ça tourne bien pour vous en ce moment ?', {
      previous: ['Vous travaillez plutôt sur quelle zone ?'],
    });
    expect(found).not.toContain('TEMPLATE_REPEATED');
    expect(found).not.toContain('OPENING_ALREADY_USED');
  });
});

// ---------------------------------------------------------------------------
// §27.5 / §14 — le français conversationnel
// ---------------------------------------------------------------------------

describe('§27.5 — le français conversationnel est permis', () => {
  it('ne pénalise ni « ça » ni « c’est »', () => {
    expect(check('Ça vous apporte déjà des demandes ou c’est calme ?').verdict).toBe('NATURAL');
  });

  it('ne pénalise pas non plus la langue écrite quand elle est employée', () => {
    // §14 : « cela », « concernant », « néanmoins », « afin de » ne sont pas des
    // marqueurs corporate — ce sont des mots de français.
    const written = 'Cela dépend surtout de votre situation actuelle.';
    const found = codes(written, { inbound: 'Bonjour, cela dépend de quoi exactement ?' });
    expect(found).not.toContain('CORPORATE_JARGON');
  });

  it('attrape en revanche la formule de plaquette', () => {
    for (const phrase of [
      'Nous accompagnons les professionnels du secteur sur ce point.',
      'Seriez-vous disponible pour un échange ?',
      'Notre solution permet de générer des demandes.',
    ]) {
      expect(codes(phrase, { goal: 'ANSWER_QUESTION' })).toContain('CORPORATE_JARGON');
    }
  });
});

// ---------------------------------------------------------------------------
// §27.6 / §27.7 / §27.8 / §12 — tu / vous
// ---------------------------------------------------------------------------

describe('§27.6 à §27.8 — le registre suit ce qui est écrit', () => {
  it('refuse de tutoyer quelqu’un qui vouvoie', () => {
    const found = codes('Et ça te ramène des demandes en ce moment ?', {
      style: style('Bonjour, vous faites quoi exactement ? Votre offre m’intéresse.'),
    });
    expect(found).toContain('ADDRESS_MODE_MISMATCH');
  });

  it('refuse de vouvoyer quelqu’un qui tutoie', () => {
    const found = codes('Et ça vous ramène des demandes ? Votre site est actif ?', {
      style: style('salut, tu fais quoi exactement ? t’as des exemples ?'),
      inbound: 'salut, tu fais quoi exactement ?',
    });
    expect(found).toContain('ADDRESS_MODE_MISMATCH');
  });

  it('accepte le vouvoiement quand la personne vouvoie', () => {
    const found = codes('Et ça vous apporte déjà des demandes régulièrement ?', {
      style: style('Bonjour, principalement mon site internet ainsi que ma fiche Google'),
    });
    expect(found).not.toContain('ADDRESS_MODE_MISMATCH');
  });

  it('ne reproche rien quand le registre n’est pas observé — et demande un repli neutre', () => {
    // §12 : sans preuve, on ne force pas le tutoiement « pour faire humain ».
    const profile = style('ok');
    expect(profile.addressMode).toBe('UNKNOWN');
    expect(codes('Et ça vous apporte des demandes ?', { style: profile })).not.toContain('ADDRESS_MODE_MISMATCH');
    expect(codes('Et ça te ramène des demandes ?', { style: profile })).not.toContain('ADDRESS_MODE_MISMATCH');

    const directive = renderStyleDirective(profile);
    expect(directive).toContain('Registre non observé');
    expect(directive).toContain('n’impose ni tutoiement ni vouvoiement');
  });
});

// ---------------------------------------------------------------------------
// §27.9 / §27.10 / §27.11 / §13 — aligner, jamais imiter
// ---------------------------------------------------------------------------

describe('§27.9 / §27.10 — on s’aligne, on ne singe pas', () => {
  it('refuse de reproduire une abréviation, même face à quelqu’un qui en met partout', () => {
    const heavy = style('slt, pk pas', 'jsp trop, bcp de taf en ce moment');
    expect(heavy.abbreviations).not.toBe('NONE');
    expect(codes('Ok, tkt on regarde ça.', { style: heavy })).toContain('TEXTISM_OR_TYPO');
  });

  it('refuse un registre « jeune » que personne n’a demandé', () => {
    expect(codes('Wesh, ça donne quoi de ton côté ?')).toContain('FORCED_SLANG');
  });

  it('refuse une faute de frappe reproduite', () => {
    expect(codes('Ok, sa marche pour moi.')).toContain('TEXTISM_OR_TYPO');
  });
});

describe('§27.11 — pas d’inflation d’emojis', () => {
  it('refuse trois emojis', () => {
    const enthusiastic = style('yo 🔥🔥 ça déchire 😍', 'grave 😂😂 trop bien 🚀');
    expect(codes('Carrément 🔥 on regarde ça 💪 top 🚀', { style: enthusiastic })).toContain('EMOJI_INFLATION');
  });

  it('refuse un emoji face à quelqu’un qui n’en met aucun', () => {
    const sober = style(
      'Bonjour, principalement mon site internet ainsi que ma fiche Google',
      'Je regarde et je reviens vers vous rapidement.',
    );
    expect(sober.emojiLevel).toBe('NONE');
    expect(codes('Ok, ça marche 👍', { style: sober })).toContain('EMOJI_INFLATION');
  });

  it('laisse passer un message sans emoji', () => {
    expect(codes('Et ça vous apporte des demandes ?')).not.toContain('EMOJI_INFLATION');
  });
});

// ---------------------------------------------------------------------------
// §27.13 / §27.14 / §11 — le rebond concret
// ---------------------------------------------------------------------------

describe('§27.13 / §27.14 — rebondir sur du concret, sans en inventer', () => {
  it('lit les éléments concrets du message réel de référence', () => {
    const anchors = concreteAnchors('Bonjour, Principalement mon site internet ainsi que ma fiche Google');
    expect(anchors).toContain('site internet');
    expect(anchors).toContain('fiche google');
    // « bonjour » et « principalement » ne sont pas des éléments concrets.
    expect(anchors).not.toContain('bonjour');
    expect(anchors).not.toContain('principalement');
  });

  it('reconnaît une réponse qui reprend l’élément', () => {
    const anchors = concreteAnchors('Bonjour, Principalement mon site internet ainsi que ma fiche Google');
    expect(classifyRebound('Votre fiche Google vous ramène des appels ?', anchors)).toBe('ANCHOR');
  });

  it('reconnaît aussi une reprise par pronom, qui est la façon dont on parle', () => {
    const anchors = concreteAnchors('Bonjour, Principalement mon site internet ainsi que ma fiche Google');
    // §11 donne cet exemple comme le BON. Il ne répète aucun mot : exiger le
    // mot exact produirait des réponses qui ressassent.
    expect(classifyRebound('Et ça vous apporte déjà régulièrement des demandes ou pas vraiment ?', anchors)).toBe(
      'ANAPHOR',
    );
  });

  it('signale une réponse qui ne se raccroche à rien', () => {
    const found = codes('Vous travaillez sur quelle zone géographique ?');
    expect(found).toContain('NO_CONCRETE_REBOUND');
    // Signalé, jamais bloquant : le contexte peut justifier de changer de sujet.
    expect(check('Vous travaillez sur quelle zone géographique ?').verdict).toBe('ACCEPTABLE');
  });

  it('n’exige aucun rebond quand leur message n’offre rien à quoi se raccrocher', () => {
    // « oui » ne porte aucun élément concret : réclamer un détail précis ici
    // reviendrait à demander d'en inventer un.
    expect(concreteAnchors('oui')).toEqual([]);
    expect(codes('Vous cherchez surtout plus de demandes en ce moment ?', { inbound: 'oui' })).not.toContain(
      'NO_CONCRETE_REBOUND',
    );
  });
});

// ---------------------------------------------------------------------------
// §27.12 / §16 — ne pas répéter ce qui est déjà dit
// ---------------------------------------------------------------------------

describe('§27.12 / §16 — le pitch ne se répète pas', () => {
  it('refuse de réexpliquer l’offre déjà expliquée', () => {
    const found = codes('On aide les pros du atelier à avoir des demandes régulières.', {
      covered: ['OFFER_EXPLAINED'],
      inbound: 'ok',
    });
    expect(found).toContain('PITCH_REPEATED');
  });

  it('accepte de réexpliquer quand on le demande', () => {
    // Une question RELANCE le sujet : répondre n'est pas répéter.
    const found = codes('On aide les pros du atelier à avoir des demandes régulières.', {
      covered: ['OFFER_EXPLAINED'],
      goal: 'ANSWER_QUESTION',
      signals: signals({ questionTopic: 'WHAT_YOU_DO' }),
      inbound: 'vous faites quoi exactement ?',
    });
    expect(found).not.toContain('PITCH_REPEATED');
  });

  // -------------------------------------------------------------------------
  // PITCH_REPEATED-FALSE-POSITIVE-R1 — une QUESTION n'est pas un pitch.
  //
  // Le 23 août 2026, « J'avais des leads mais c'était surtout des curieux
  // personne n'achetait » a produit le brouillon « Tu faisais la pub sur
  // quelle prestation à l'époque ? », écarté en `PITCH_REPEATED` parce que
  // `topicsCoveredByText` lisait le mot « pub » dans le corps entier, sans
  // distinguer une question d'une affirmation. Le brouillon ne réexplique
  // rien : il demande. `covered: ['OFFER_EXPLAINED']` reproduit un fil où
  // l'offre a déjà été présentée, exactement l'état sous lequel le faux
  // positif s'est produit.
  // -------------------------------------------------------------------------

  it('cas réel — une question de diagnostic sur la pub passée du prospect n’est pas un pitch', () => {
    const found = codes('Tu faisais la pub sur quelle prestation à l’époque ?', {
      covered: ['OFFER_EXPLAINED'],
      inbound: 'J’avais des leads mais c’était surtout des curieux personne n’achetait',
    });
    expect(found).not.toContain('PITCH_REPEATED');
  });

  it('cas B — une question sur la qualité des demandes n’est pas un pitch', () => {
    const found = codes('C’était surtout un problème de quantité ou de qualité des demandes ?', {
      covered: ['OFFER_EXPLAINED'],
      inbound: 'J’avais des leads mais c’était surtout des curieux personne n’achetait',
    });
    expect(found).not.toContain('PITCH_REPEATED');
  });

  it('cas C — une question sur le rappel des leads n’est pas un pitch', () => {
    const found = codes('Tu les rappelais rapidement derrière ?', {
      covered: ['OFFER_EXPLAINED'],
      inbound: 'J’avais des leads mais c’était surtout des curieux personne n’achetait',
    });
    expect(found).not.toContain('PITCH_REPEATED');
  });

  it('cas D — une question sur l’offre passée du prospect n’est pas un pitch', () => {
    const found = codes('Tu faisais quoi comme offre à ce moment-là ?', {
      covered: ['OFFER_EXPLAINED'],
      inbound: 'J’avais des leads mais c’était surtout des curieux personne n’achetait',
    });
    expect(found).not.toContain('PITCH_REPEATED');
  });

  it('cas E/F — un vrai pitch reformulé reste détecté comme répétition', () => {
    // Le brouillon AFFIRME de nouveau ce que l'offre couvre déjà — à la
    // différence des cas ci-dessus, ce n'est pas une question.
    const found = codes('Je mets en place des pubs Facebook et Instagram ciblées dans ta zone.', {
      covered: ['OFFER_EXPLAINED'],
      inbound: 'ok',
    });
    expect(found).toContain('PITCH_REPEATED');
  });

  it('une question qui emploie le lexique d’offre reste NATURAL de bout en bout', () => {
    // Le brouillon réel ne doit pas seulement échapper à PITCH_REPEATED : il
    // ne doit être écarté par AUCUNE porte pour cette seule raison lexicale.
    const report = check('Tu faisais la pub sur quelle prestation à l’époque ?', {
      covered: ['OFFER_EXPLAINED'],
      inbound: 'J’avais des leads mais c’était surtout des curieux personne n’achetait',
    });
    expect(report.findings.map((f) => f.code)).not.toContain('PITCH_REPEATED');
  });
});

// ---------------------------------------------------------------------------
// §27.15 / §27.16 / §17 — l'appel
// ---------------------------------------------------------------------------

describe('§27.15 / §27.16 — l’appel ne se propose pas parce qu’ils ont répondu', () => {
  it('refuse une proposition d’échange sur un signal LOW', () => {
    const found = codes('On peut s’appeler quinze minutes si vous voulez ?', {
      inbound: 'ok',
      signals: signals({ callReadiness: 'LOW' }),
    });
    expect(found).toContain('CTA_TOO_EARLY');
  });

  it('accepte la proposition quand l’appel est explicitement demandé', () => {
    const found = codes('Bien sûr, on peut s’appeler — quel créneau vous arrange ?', {
      goal: 'PROPOSE_CALL',
      inbound: 'on peut s’appeler ?',
      signals: signals({ explicitCallRequest: true, callReadiness: 'HIGH', questionTopic: 'CALL_REQUEST' }),
    });
    expect(found).not.toContain('CTA_TOO_EARLY');
  });

  it('refuse de reproposer un échange déjà proposé', () => {
    const found = codes('On peut s’appeler si vous voulez.', {
      goal: 'PROPOSE_CALL',
      covered: ['CALL_PROPOSED'],
      signals: signals({ callReadiness: 'HIGH', buyingSignal: 'STRONG' }),
      inbound: 'ok pourquoi pas',
    });
    expect(found).toContain('CTA_TOO_EARLY');
  });
});

// ---------------------------------------------------------------------------
// §27.22 — cas très courts (§22)
// ---------------------------------------------------------------------------

describe('§22 — les messages très courts ont tous un budget cohérent', () => {
  const SHORT_REPLIES = [
    'oui',
    'pk pas',
    'combien ?',
    'ça dépend',
    'non',
    'pas maintenant',
    'pourquoi ?',
    'comment ça ?',
    'vous faites quoi ?',
  ];

  it('donne à chacun un budget très serré', () => {
    for (const reply of SHORT_REPLIES) {
      const budget = computeLengthBudget(reply, 'instagram_dm');
      expect(budget.band).toBe('VERY_SHORT');
      expect(budget.maxSentences).toBeLessThanOrEqual(2);
      expect(budget.maxChars).toBeLessThanOrEqual(180);
    }
  });

  it('accepte une réponse d’une phrase à chacun', () => {
    for (const reply of SHORT_REPLIES) {
      const report = check('Vous cherchez surtout à avoir plus de demandes en ce moment ?', { inbound: reply });
      expect(report.findings.map((finding) => finding.code)).not.toContain('TOO_LONG');
      expect(report.findings.map((finding) => finding.code)).not.toContain('TOO_MANY_SENTENCES');
    }
  });
});

// ---------------------------------------------------------------------------
// §27.25 / §27.26 — la porte de naturalité fait bien son travail
// ---------------------------------------------------------------------------

describe('§27.25 / §27.26 — le verdict et sa restitution', () => {
  it('rend NATURAL, ACCEPTABLE ou UNNATURAL selon la sévérité', () => {
    expect(check('Et ça vous apporte déjà des demandes ou pas vraiment ?').verdict).toBe('NATURAL');
    expect(check('Vous travaillez sur quelle zone ?').verdict).toBe('ACCEPTABLE');
    expect(check('Merci pour votre retour ! On peut en parler ?').verdict).toBe('UNNATURAL');
  });

  it('rend les constats bloquants au modèle, sans jamais recopier le message du prospect', () => {
    const report = check('Merci pour votre retour ! Ça vous apporte des demandes ? Et vous cherchez quoi ?');
    const corrections = renderCorrections(report);
    expect(corrections).toContain('MULTIPLE_QUESTIONS');
    expect(corrections).toContain('GENERIC_OPENING');
    for (const word of ['site internet', 'fiche Google', 'Principalement']) {
      expect(corrections).not.toContain(word);
    }
  });

  it('ne mélange jamais naturalité et sécurité', () => {
    // Un texte parfaitement sûr peut être parfaitement artificiel : le rapport
    // de naturalité ne porte AUCUN drapeau de garde-fou, et réciproquement.
    const report = check('Merci pour votre retour !');
    expect(Object.keys(report)).not.toContain('guardrailFlags');
    expect(Object.keys(report)).not.toContain('blocked');
  });
});

// ---------------------------------------------------------------------------
// §27.30 — rien de sensible ne peut entrer
// ---------------------------------------------------------------------------

describe('§27.30 — le contrôle ne peut pas profiler quelqu’un', () => {
  const SECRET = 'Ma banque m’a refusé un prêt le mois dernier, je suis à découvert';

  it('n’écrit rien du message du prospect dans ses constats ni ses mesures', () => {
    // La distinction qui compte : les ÉLÉMENTS CONCRETS sont, par construction,
    // des mots de leur message — c'est leur raison d'être, et ils partent au
    // rédacteur qui reçoit déjà le fil entier. Tout le reste du rapport —
    // constats, sévérités, extraits, mesures — ne doit rien en porter, parce que
    // c'est cette partie-là qui est journalisée et relue.
    const report = check('Ok, on regarde ça ensemble.', { inbound: SECRET, style: style(SECRET) });
    const observable = JSON.stringify({
      verdict: report.verdict,
      findings: report.findings,
      metrics: report.metrics,
      budget: report.budget,
      rebound: report.rebound,
    });
    for (const word of ['banque', 'prêt', 'découvert', 'refusé']) {
      expect(observable).not.toContain(word);
    }
    expect(report.metrics.chars).toBeGreaterThan(0);
  });

  it('ne construit aucun trait sensible : le profil de style n’en porte pas le type', () => {
    // §16 de R1 n'est pas une consigne de rédaction : `StyleProfile` ne contient
    // que des énumérations linguistiques et deux compteurs. Aucun champ ne
    // PEUT recevoir un âge, une origine, une situation financière.
    const profile = style(SECRET, 'bref, je suis prudent en ce moment');
    const serialized = JSON.stringify(profile);
    for (const word of ['banque', 'prêt', 'découvert']) {
      expect(serialized).not.toContain(word);
    }
    expect(profile.observedChars).toBeGreaterThan(0);
  });

  it('les éléments concrets restent des mots isolés, plafonnés, jamais la phrase', () => {
    const anchors = concreteAnchors(
      'Nous avons trois salariés, un local à Bordeaux, et un chiffre d’affaires en baisse cette année',
    );
    expect(anchors.length).toBeLessThanOrEqual(6);
    expect(anchors.join(' ')).not.toContain('Nous avons trois salariés');
    for (const anchor of anchors) expect(anchor.split(' ').length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Les consignes rendues au modèle
// ---------------------------------------------------------------------------

describe('le cadrage §6 part réellement dans le prompt', () => {
  it('demande la prochaine phrase naturelle, pas un bon message commercial', () => {
    expect(CONVERSATION_FRAME).toContain('PROCHAINE PHRASE NATURELLE');
    expect(CONVERSATION_FRAME).toContain('au plus UNE question');
    expect(CONVERSATION_FRAME).toContain('n’ouvre PAS par un remerciement');
    expect(CONVERSATION_FRAME).toContain('ne propose pas d’échange parce que');
  });

  it('rend un budget chiffré, pas une intention', () => {
    const directive = renderLengthDirective(computeLengthBudget('ok', 'instagram_dm'));
    expect(directive).toContain('au plus 2 phrases');
    expect(directive).toContain('huit mots');
  });
});

describe('les mesures sont celles qu’on croit', () => {
  it('compte phrases, mots, questions et emojis', () => {
    const metrics = measureDraft('Ok 👍. Et ça vous apporte des demandes ?');
    expect(metrics.sentences).toBe(2);
    expect(metrics.questions).toBe(1);
    expect(metrics.emojis).toBe(1);
    expect(metrics.words).toBeGreaterThan(5);
  });
});
