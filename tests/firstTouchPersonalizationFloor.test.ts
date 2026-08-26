/**
 * HERMES-FIRST-TOUCH-PERSONALIZATION-FLOOR-R1 + DIVERSITY-R1 + TU-MARKERS-R1.
 *
 * Trois défauts mesurés sur le rejeu de SENDER-ROLE-R1, et rien d'autre :
 *
 *   * 5 candidats sur 18 repartaient en générique alors qu'une observation
 *     ancrée leur avait été donnée ;
 *   * 10 sur 18 posaient la même question d'origine — la monoculture n'avait
 *     pas disparu, elle avait déménagé ;
 *   * 1 sur 18 était refusé pour un tutoiement qu'il ne portait pas, parce que
 *     « tête » contient la suite ASCII `te` entre deux frontières `\b`.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  checkFirstTouch,
  renderFirstTouchCorrections,
  sharedGroundedWords,
  type FirstTouchCode,
} from '@/lib/pipeline/firstTouchStyle';
import {
  buildFirstTouchPersonalization,
  curiosityDirections,
  renderPersonalizationBlock,
  type CuriosityDirection,
  type FirstTouchPersonalization,
  type PersonalizationEvidence,
} from '@/lib/pipeline/firstTouchPersonalization';
import { countAddressMarkers, detectAddressMode, resolveAddressMode } from '@/lib/conversation/style';
import { detectBuyerRole } from '@/lib/pipeline/firstTouchSenderRole';

const FACTS: readonly string[] = [
  'ils annoncent intervenir à domicile',
  'ils mettent en avant : reportage interieur et retouche des portraits',
  'leur site s’adresse aux particuliers ET aux professionnels',
];

/**
 * Le vocabulaire du MÉTIER, tel qu'une niche le déclare
 * (`config/niches/<clé>.json`, `serviceTerms` + `coreActivityTerms`).
 *
 * Il n'est écrit nulle part dans `src/` : Hermes ne sait rien d'un métier tant
 * qu'un opérateur ne le lui a pas déclaré. C'est l'appelant qui le passe, et
 * c'est ce que ce fichier vérifie — y compris qu'un plancher SANS déclaration
 * reste actif, simplement plus lâche.
 */
const TRADE_TERMS: readonly string[] = ['photographie de studio', 'reportage', 'portrait'];

function codes(body: string, hook?: { available: boolean; citedEvidenceIds: readonly string[] }): FirstTouchCode[] {
  return checkFirstTouch({ body, groundedFacts: FACTS, hook: hook ?? null, tradeTerms: TRADE_TERMS })
    .findings.filter((finding) => finding.severity === 'BLOCKING')
    .map((finding) => finding.code);
}

/** Une ligne de preuve utilisable : lecture directe, confiance au-dessus du seuil. */
function evidence(id: string, field: string, value: string): PersonalizationEvidence {
  return { id, field, valueText: value, provider: 'website', method: 'crawl', confidence: 0.9, sourceUrl: 'https://x.fr/' };
}

// ---------------------------------------------------------------------------
// A — le PLANCHER de personnalisation
// ---------------------------------------------------------------------------

describe('A — une observation disponible doit être reprise', () => {
  const AVEC_HOOK = { available: true, citedEvidenceIds: ['e1'] } as const;

  /** Recopié du rejeu de SENDER-ROLE-R1 : générique alors qu'un fait existait. */
  const GÉNÉRIQUE = 'Bonjour, simple curiosité : qu’est-ce qui vous a donné envie de lancer Studio Meridien au départ ?';

  it('le message générique du rejeu est désormais refusé', () => {
    expect(codes(GÉNÉRIQUE, AVEC_HOOK)).toContain('MISSING_GROUNDED_HOOK');
  });

  it('sans accroche annoncée, le comportement d’avant est reproduit à l’identique', () => {
    // Le défaut — pas d'accroche — ne reproche rien. C'est ce qui rend la
    // comparaison vérifiable plutôt que promise.
    expect(codes(GÉNÉRIQUE)).toEqual([]);
    expect(codes(GÉNÉRIQUE, { available: false, citedEvidenceIds: [] })).toEqual([]);
  });

  it('un message qui reprend l’observation passe', () => {
    const bon =
      'Bonjour, j’ai vu que vous intervenez à domicile, je croise assez peu ce fonctionnement. ' +
      'Vous avez toujours travaillé comme ça ?';
    expect(codes(bon, AVEC_HOOK)).toEqual([]);
  });

  /**
   * Le plancher n'exige PAS l'accroche retenue : `groundedFacts` porte le
   * contexte métier autant que l'accroche, et ouvrir sur un autre fait vérifié
   * est une personnalisation aussi réelle.
   */
  it('reprendre un AUTRE fait vérifié satisfait le plancher', () => {
    const autre =
      'Bonjour, j’ai vu que vous faites du reportage en intérieur et de la retouche de portraits. ' +
      'Vous avez surtout des demandes sur l’un des deux ?';
    expect(codes(autre, AVEC_HOOK)).toEqual([]);
  });

  it('une observation reprise SANS provenance est refusée à part', () => {
    const sansCitation =
      'Bonjour, j’ai vu que vous intervenez à domicile, je croise assez peu ce fonctionnement. ' +
      'Vous avez toujours travaillé comme ça ?';
    const found = codes(sansCitation, { available: true, citedEvidenceIds: [] });
    expect(found).toContain('HOOK_NOT_CITED');
    // Et jamais les deux : un message générique ne récolte pas aussi « non cité ».
    expect(codes(GÉNÉRIQUE, { available: true, citedEvidenceIds: [] })).not.toContain('HOOK_NOT_CITED');
  });

  it('une observation NON ancrée ne satisfait pas le plancher', () => {
    const inventé = 'Bonjour, j’ai vu que vous posez du des tirages grand format sur toile. Vous avez commencé par là ?';
    const found = codes(inventé, AVEC_HOOK);
    expect(found).toContain('UNGROUNDED_OBSERVATION');
    expect(found).toContain('MISSING_GROUNDED_HOOK');
  });

  it('la reprise dit au modèle QUOI corriger, pas seulement qu’il a échoué', () => {
    const report = checkFirstTouch({ body: GÉNÉRIQUE, groundedFacts: FACTS, hook: AVEC_HOOK });
    const corrections = renderFirstTouchCorrections(report);
    expect(corrections).toContain('MISSING_GROUNDED_HOOK');
    expect(corrections).toContain('OUVRE sur le détail vérifié');
  });

  it('le plancher n’est jamais exigé quand rien n’a été observé', () => {
    // `groundedFacts` vide ET aucune accroche : le message générique est la
    // bonne réponse, et le prompt le demande explicitement.
    expect(
      checkFirstTouch({ body: GÉNÉRIQUE, groundedFacts: [], hook: { available: false, citedEvidenceIds: [] } })
        .findings.filter((f) => f.severity === 'BLOCKING'),
    ).toEqual([]);
  });

  /**
   * Le plancher a d'abord été bâti sur `observationClaims`, et il rendait CINQ
   * faux refus sur 24 au premier rejeu. Ces quatre formes sont celles qui l'ont
   * montré : elles reprennent l'observation mot pour mot et n'ouvrent par
   * aucune tournure connue du lexique.
   */
  it('une observation reprise SANS tournure d’ouverture connue satisfait le plancher', () => {
    const FORMES: readonly string[] = [
      'Bonjour, entre vos reportages en intérieur et en extérieur, je me suis rendu compte que j’ignorais lequel dominait. Vous travaillez le plus souvent sur lequel ?',
      'Bonjour, votre site s’adresse aux particuliers et aux professionnels. Je connais assez peu ce mélange. Qu’est-ce qui change le plus d’un public à l’autre ?',
      'Bonjour, j’ai vu sur votre site que vous travaillez avec les particuliers comme les professionnels. Je croise ça assez peu. Vous en avez plutôt lesquels ?',
      'Bonjour, votre site mentionne des prestations pour les particuliers et les professionnels. C’est rare. Le travail change beaucoup entre les deux ?',
    ];
    for (const body of FORMES) {
      expect(codes(body, AVEC_HOOK), body).not.toContain('MISSING_GROUNDED_HOOK');
      expect(sharedGroundedWords(body, FACTS, TRADE_TERMS).length, body).toBeGreaterThan(0);
    }
  });

  /**
   * Le mot du MÉTIER ne prouve rien. Sans cette exclusion, un message
   * parfaitement générique satisfait le plancher grâce au seul nom du métier —
   * qui décrit toute la cible et n'a donc rien observé de personne.
   */
  it('le vocabulaire du métier ne satisfait pas le plancher', () => {
    const générique =
      'Bonjour, je viens de découvrir votre activité et le métier m’intrigue. ' +
      'Qu’est-ce qui vous a donné envie de vous lancer dans la photographie de studio ?';
    expect(sharedGroundedWords(générique, FACTS, TRADE_TERMS)).toEqual([]);
    expect(codes(générique, AVEC_HOOK)).toContain('MISSING_GROUNDED_HOOK');
  });

  /**
   * L'autre moitié de la même règle, et la raison pour laquelle ce vocabulaire
   * n'est PAS écrit dans `src/` : sans déclaration de niche, le plancher ne
   * peut pas savoir que « reportage » nomme le métier. Il reste actif — un mot
   * partagé est toujours exigé — mais il est plus lâche, et cette différence
   * est mesurable plutôt que promise.
   */
  it('sans vocabulaire déclaré, le plancher reste actif — simplement plus lâche', () => {
    const générique =
      'Bonjour, je viens de découvrir votre activité et le métier m’intrigue. ' +
      'Qu’est-ce qui vous a donné envie de vous lancer dans le reportage ?';
    // Déclaré, le mot du métier ne compte pas…
    expect(sharedGroundedWords(générique, FACTS, TRADE_TERMS)).toEqual([]);
    // …et sans déclaration, il redevient un mot comme un autre.
    expect(sharedGroundedWords(générique, FACTS)).toContain('reportage');
    // Et un message qui ne partage RIEN reste refusé, déclaration ou pas.
    const rien = 'Bonjour, par curiosité, qu’est-ce qui vous a donné envie de vous lancer ?';
    expect(sharedGroundedWords(rien, FACTS)).toEqual([]);
    expect(
      checkFirstTouch({ body: rien, groundedFacts: FACTS, hook: AVEC_HOOK }).findings
        .filter((finding) => finding.severity === 'BLOCKING')
        .map((finding) => finding.code),
    ).toContain('MISSING_GROUNDED_HOOK');
  });

  it('les autres génériques réellement produits sont tous refusés', () => {
    const GÉNÉRIQUES: readonly string[] = [
      'Bonjour, simple curiosité : qu’est-ce qui vous a donné envie de lancer Studio Meridien au départ ?',
      'Bonjour, par curiosité, quel type de travail revient le plus souvent chez vous en ce moment ?',
      'Bonjour, je découvre votre activité et je suis curieux : qu’est-ce qui vous a donné envie de vous lancer dans la photographie de studio ?',
    ];
    for (const body of GÉNÉRIQUES) expect(codes(body, AVEC_HOOK), body).toContain('MISSING_GROUNDED_HOOK');
  });

  it('`observationClaims` n’a pas bougé — sa frontière reste celle du round précédent', () => {
    // Le plancher ne s'appuie plus dessus, et surtout ne l'a pas élargi : la
    // régression de FIRST-TOUCH-NATURALNESS-TUNE-R1 est gelée forme par forme.
    const sansTournure = 'Bonjour, votre site mentionne des prestations pour les particuliers. C’est rare ?';
    expect(codes(sansTournure, AVEC_HOOK)).not.toContain('UNGROUNDED_OBSERVATION');
  });

  it('la fonction ne reçoit toujours ni prospect ni campagne — aucune exception écrivable', async () => {
    const source = await readFile('src/lib/pipeline/firstTouchStyle.ts', 'utf-8');
    // Ce que le module NE PEUT PAS savoir : de qui il parle. Son entrée est un
    // texte, des faits et — depuis ce round — le vocabulaire d'un métier, qui
    // ne nomme aucune entreprise. Aucun nom de prospect, de compte ou de
    // campagne n'est atteignable depuis ici, donc aucune exception nominative
    // n'est écrivable.
    expect(source).not.toMatch(/prospectId|instagram_handle|campaign_id/);
    expect(source).toMatch(/export function checkFirstTouch\(input: FirstTouchInput\)/);
  });
});

// ---------------------------------------------------------------------------
// B — la DIVERSITÉ des directions
// ---------------------------------------------------------------------------

describe('B — les directions suivent les preuves', () => {
  function personalizationFor(rows: readonly PersonalizationEvidence[]): FirstTouchPersonalization {
    return buildFirstTouchPersonalization({ evidence: rows, displayName: 'Test', city: null, angleHook: null });
  }

  it('une liste de PRESTATIONS n’ouvre pas la question d’origine', () => {
    const perso = personalizationFor([evidence('e1', 'services', 'reportage interieur, retouche des portraits')]);
    const directions = curiosityDirections(perso);
    expect(directions).toContain('RECURRING_WORK');
    expect(directions).not.toContain('MODEL_ORIGIN');
    expect(directions).not.toContain('MODEL_EVOLUTION');
  });

  it('une MODALITÉ de travail l’ouvre, et c’est le seul cas', () => {
    // `MOBILE_KEYS` compare le terme ENTIER d'une liste séparée par virgules :
    // « a domicile » est une modalité, « reportage a domicile » une prestation.
    const perso = personalizationFor([evidence('e1', 'services', 'a domicile')]);
    expect(perso.hook?.angle).toBe('MOBILE_SERVICE');
    expect(curiosityDirections(perso)).toContain('MODEL_ORIGIN');
    expect(curiosityDirections(perso)).not.toContain('RECURRING_WORK');
  });

  it('une AUDIENCE ouvre le mixte de clientèle', () => {
    const perso = personalizationFor([
      evidence('e1', 'website_description', 'reportage photo pour particuliers et professionnels'),
    ]);
    expect(curiosityDirections(perso)).toEqual(expect.arrayContaining(['CUSTOMER_MIX', 'SEGMENT_DIFFERENCE']));
  });

  it('rien d’observé n’ouvre rien — aucune direction n’est inventée', () => {
    const vide = personalizationFor([]);
    expect(curiosityDirections(vide)).toEqual([]);
    expect(renderPersonalizationBlock(vide)).toContain('rien d’observé n’en ouvre');
  });

  /**
   * Une accroche venue de `prospect_angles` est un raisonnement, pas une
   * observation. Elle n'ancre rien depuis FIRST-TOUCH-NATURALNESS-TUNE-R1, et
   * elle n'ouvre donc aucune direction non plus.
   */
  it('l’angle commercial de repli n’ouvre aucune direction', () => {
    const repli = buildFirstTouchPersonalization({
      evidence: [],
      displayName: 'Test',
      city: null,
      angleHook: 'J’ai vu que vous proposez du reportage à domicile.',
    });
    expect(repli.hook?.evidenceIds).toEqual([]);
    expect(curiosityDirections(repli)).toEqual([]);
  });

  it('les accroches solides NON retenues portent aussi de la curiosité', () => {
    const perso = personalizationFor([
      evidence('e1', 'website_description', 'reportage pour particuliers et professionnels'),
      evidence('e2', 'services', 'reportage interieur, retouche des portraits'),
    ]);
    const directions = curiosityDirections(perso);
    expect(directions.length).toBeGreaterThan(2);
    // Celle de l'accroche RETENUE vient en premier : la question part du fait
    // qu'on va réellement dire.
    expect(directions[0]).toBe('CUSTOMER_MIX');
  });

  it('le bloc rend les directions et dit que ce ne sont pas des phrases', () => {
    const perso = personalizationFor([evidence('e1', 'services', 'reportage interieur, retouche des portraits')]);
    const block = renderPersonalizationBlock(perso);
    expect(block).toContain('CE QUE TU PEUX AVOIR ENVIE DE SAVOIR');
    expect(block).toContain('ce sont des DIRECTIONS, pas des phrases');
    expect(block).toContain('OBLIGATOIRE');
  });

  it('MOBILE_SERVICE ne décide plus l’ouverture quand des prestations existent', () => {
    // La mesure : MOBILE_SERVICE produisait UNE phrase pour 211 prospects.
    const perso = personalizationFor([
      evidence('e1', 'services', 'a domicile, retouche des portraits, reportage interieur'),
    ]);
    expect(perso.hook?.angle).toBe('SERVICE_MIX');
    expect(perso.alsoAvailable.map((h) => h.angle)).toContain('MOBILE_SERVICE');
  });

  /** Toute direction rendue doit produire une question que R1 accepte. */
  it('aucune direction ne pousse vers une question de client', () => {
    const FORMES: Readonly<Record<CuriosityDirection, string>> = {
      MODEL_ORIGIN: 'Vous avez toujours travaillé comme ça ?',
      MODEL_EVOLUTION: 'Ça a changé depuis vos débuts ?',
      CUSTOMER_MIX: 'C’est plutôt des particuliers ou des pros au quotidien ?',
      SEGMENT_DIFFERENCE: 'Ça change beaucoup entre les deux ?',
      RECURRING_WORK: 'C’est l’intérieur qui revient le plus souvent ?',
      SPECIALIZATION: 'Vous êtes surtout partis sur l’intérieur ?',
      SERVICE_ORIGIN: 'Vous l’avez ajouté après avoir commencé ?',
      OPERATING_CHOICE: 'C’était un choix de fonctionner comme ça ?',
      LOCAL_DEMAND: 'C’est quel type de demande qui domine dans le coin ?',
    };
    for (const [direction, question] of Object.entries(FORMES)) {
      expect(detectBuyerRole(question), direction).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// C — les frontières de mot du tutoiement
// ---------------------------------------------------------------------------

describe('C — « tête » ne contient pas de tutoiement', () => {
  const RÉELS: readonly string[] = [
    'tu', 'Tu vois', 'toi', 'à toi', 'te', 'ça te va', 'je te dis',
    "t'as", "t'es", "t'avais", "j'te dis", 'on se tutoie', 'ton site', 'ton budget',
  ];
  const ACCENTUÉS: readonly string[] = [
    'tête', 'Tête', 'TÊTE', 'arrête', 'fête', 'bête', 'honnête', 'entête', 'têtu', 'côte', 'quête', 'requête',
  ];

  it('chaque marqueur réel compte encore', () => {
    for (const text of RÉELS) expect(countAddressMarkers(text).tu, text).toBeGreaterThan(0);
  });

  it('aucun mot accentué ne compte plus', () => {
    for (const text of ACCENTUÉS) expect(countAddressMarkers(text).tu, text).toBe(0);
  });

  it('le vouvoiement est intact', () => {
    for (const text of ['vous', 'votre site', 'vos prestations', 'vous-même', 'chez vous']) {
      expect(countAddressMarkers(text).vous, text).toBeGreaterThan(0);
    }
  });

  /** Le candidat réellement refusé pendant le rejeu de SENDER-ROLE-R1. */
  it('le message de premier contact réellement refusé passe désormais', () => {
    const body =
      'Bonjour, en découvrant votre activité, j’ai vu au passage que vous intervenez à domicile. ' +
      'Vous aviez ce fonctionnement en tête dès le lancement ?';
    expect(countAddressMarkers(body)).toEqual({ tu: 0, vous: 3 });
    expect(codes(body, { available: true, citedEvidenceIds: ['e1'] })).not.toContain('ADDRESS_MODE_MIXED');
  });

  it('un vrai mélange tu/vous reste refusé', () => {
    const mélangé = 'Bonjour, j’ai vu que vous intervenez à domicile. Tu fais ça depuis longtemps ?';
    expect(codes(mélangé, { available: true, citedEvidenceIds: ['e1'] })).toContain('ADDRESS_MODE_MIXED');
  });

  it('le registre d’un texte isolé est lu juste dans les deux sens', () => {
    expect(detectAddressMode('Vous aviez ce fonctionnement en tête ?')).toBe('VOUS');
    expect(detectAddressMode('ça te va ?')).toBe('TU');
    expect(detectAddressMode('Et ça me coûte combien de tester ?')).toBe('UNKNOWN');
  });

  /**
   * Le rail de RÉPONSE. `resolveAddressMode` traverse les messages ambigus
   * pour s'arrêter au dernier qui tranche : un message dont le seul « marqueur »
   * était le `te` de « coûte » ne renverse donc rien, et le registre déjà
   * établi tient. C'est le comportement fail-closed que HERMES-CONTACT-PURPOSE-R1
   * a écrit, et ce correctif ne le change pas — il le rend simplement exact.
   */
  it('le registre d’un FIL ne bascule pas sur un mot accentué', () => {
    expect(resolveAddressMode(['tu fais quoi comme prestations ?', 'Et ça me coûte combien de tester ?'])).toBe('TU');
    expect(resolveAddressMode(['Bonjour, vous proposez quoi ?', 'Ok après les 7 jours ça coûte combien ?'])).toBe('VOUS');
    expect(resolveAddressMode(['Bonjour, vous proposez quoi ?', 'et ça te coûte combien ?'])).toBe('TU');
  });

  it('le lexique n’a plus de frontière ASCII — la régression serait invisible autrement', async () => {
    const source = await readFile('src/lib/conversation/style.ts', 'utf-8');
    const tu = source.match(/const TU_MARKERS = new RegExp\(([\s\S]*?)\n\);/)?.[1] ?? '';
    expect(tu).not.toMatch(/\\\\b/);
    expect(tu).toContain('TU_START');
    expect(tu).toContain('TU_END');
  });
});
