/**
 * HERMES-FIRST-TOUCH-SENDER-ROLE-R1 — le message est bien écrit, et il se fait
 * passer pour quelqu'un d'autre.
 *
 * Les trois manifestes verrouillés le 25 août 2026 à 18:42 étaient tous les
 * trois `CONVERSATIONAL` : ancrés, courts, naturels, sans pitch et sans jargon.
 * Aucune garde de ce dépôt ne pouvait les refuser, parce qu'aucune ne regardait
 * ce qu'ils faisaient croire de l'expéditeur.
 *
 * Les sept blocs ci-dessous sont ceux que la mission demande, dans son ordre.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  checkFirstTouch,
  observationClaims,
  type FirstTouchCode,
} from '@/lib/pipeline/firstTouchStyle';
import { detectBuyerRole, interrogativeSpans } from '@/lib/pipeline/firstTouchSenderRole';

/** Les faits que les messages de ce fichier ont le droit d'affirmer. */
const FACTS: readonly string[] = [
  'ils annoncent intervenir à domicile',
  'ils mettent en avant : reportage interieur et reportage exterieur',
  'leur site s’adresse aux particuliers ET aux professionnels',
  'ils proposent du portrait en lumière naturelle, à la main',
  'ils proposent aussi premium',
  'leurs tarifs sont affichés en ligne',
];

function blocking(body: string, facts: readonly string[] = FACTS): FirstTouchCode[] {
  return checkFirstTouch({ body, groundedFacts: facts })
    .findings.filter((finding) => finding.severity === 'BLOCKING')
    .map((finding) => finding.code);
}

function families(body: string): string[] {
  return detectBuyerRole(body).map((finding) => finding.family);
}

// ---------------------------------------------------------------------------
// 1 — l'ouverture d'acquisition
// ---------------------------------------------------------------------------

/**
 * Ce bloc dit une chose et son contraire, et les deux sont voulus.
 *
 * L'ouverture de qualification n'est PAS refusée par le code, et ce round ne la
 * refuse pas davantage : un opérateur peut parfaitement l'avoir validée dans
 * ses propres exemples de voix, et en faire une règle rendrait son corpus de
 * référence illégal contre lui-même. Elle est refusée par le PROMPT, où les
 * stratégies vivent, et c'est là qu'on la vérifie.
 *
 * Ce que ce round ajoute est l'autre moitié : la garde de rôle ne doit pas
 * l'attraper par ricochet. Une garde qui refuse la mauvaise chose pour la
 * mauvaise raison est plus dangereuse qu'une garde absente, parce qu'elle a
 * l'air de fonctionner.
 */
describe('1 — l’ouverture d’acquisition reste affaire de prompt, pas de rôle', () => {
  const ACQUISITION_TOUR_1 =
    'Bonjour, petite question : aujourd’hui, vos nouveaux clients viennent surtout des ' +
    'recommandations et des réseaux, ou vous avez déjà autre chose qui fonctionne régulièrement ?';

  it('le prompt refuse de la prescrire, et nomme le registre voulu à la place', async () => {
    const source = await readFile('src/lib/pipeline/message.ts', 'utf-8');
    expect(source).not.toMatch(/une question posée simplement, sur le fait d’avoir plus de demandes/);
    expect(source).toMatch(/Ta question porte donc sur L'ENTREPRISE/);
  });

  it('la garde de RÔLE ne l’attrape pas — ce n’est pas la question d’un client', () => {
    expect(detectBuyerRole(ACQUISITION_TOUR_1)).toEqual([]);
  });

  it('le prompt interdit nommément les questions d’achat', async () => {
    const source = await readFile('src/lib/pipeline/message.ts', 'utf-8');
    expect(source).toMatch(/poser une question que poserait quelqu'un qui veut acheter la prestation/);
    // La ligne de 0fec132 qui AUTORISAIT explicitement la zone d'intervention.
    expect(source).not.toMatch(/Ta question peut porter sur : leur zone d'intervention/);
  });
});

// ---------------------------------------------------------------------------
// 2 — les trois défauts réellement produits
// ---------------------------------------------------------------------------

describe('2 — le rôle d’acheteur, sur les trois messages réellement verrouillés', () => {
  /**
   * Recopiés depuis `r6b_dispatch_manifests`, verrouillés le 25 août 2026 à
   * 18:42:58, 18:43:00 et 18:43:01. Aucun n'est parti.
   */
  const VERROUILLÉS: ReadonlyArray<readonly [string, string, string]> = [
    [
      '@wash.lh',
      'Bonjour, j’ai vu que vous intervenez directement à domicile. Je trouve ce format plutôt ' +
        'pratique. Il faut prévoir un accès à l’eau sur place ?',
      'PREREQUISITE',
    ],
    [
      '@laveautocaen',
      'Bonjour, votre site s’adresse aux particuliers et aux professionnels, c’est une combinaison ' +
        'que je vois assez peu. Les professionnels peuvent aussi vous confier un seul véhicule ?',
      'ELIGIBILITY',
    ],
    [
      '@caautodetail_',
      'Bonjour, j’ai vu que vous intervenez à domicile. Je croise assez peu ce fonctionnement. ' +
        'Vous vous déplacez dans quelles communes en général ?',
      'COVERAGE',
    ],
  ];

  it('les trois étaient CONVERSATIONAL avant ce round — rien d’autre ne les refusait', () => {
    for (const [handle, body] of VERROUILLÉS) {
      const codes = blocking(body).filter(
        (code) => code !== 'BUYER_ROLE_QUESTION' && code !== 'BUYER_ROLE_INTENT',
      );
      expect(codes, handle).toEqual([]);
    }
  });

  it('les trois sont désormais refusés, chacun sur SA famille', () => {
    for (const [handle, body, family] of VERROUILLÉS) {
      expect(families(body), handle).toContain(family);
      expect(blocking(body), handle).toContain('BUYER_ROLE_QUESTION');
      expect(checkFirstTouch({ body, groundedFacts: FACTS }).verdict, handle).toBe('OFF_TONE');
    }
  });

  it('leur ancrage n’a jamais été en cause — ce n’est pas ce qu’on leur reproche', () => {
    for (const [handle, body] of VERROUILLÉS) {
      expect(blocking(body), handle).not.toContain('UNGROUNDED_OBSERVATION');
    }
  });
});

// ---------------------------------------------------------------------------
// 3 — devis, disponibilité, logistique
// ---------------------------------------------------------------------------

describe('3 — prix, créneau et déroulé d’intervention', () => {
  const ACHETEUR: ReadonlyArray<readonly [string, string]> = [
    ['PRICE_QUOTE', 'Bonjour, j’ai vu vos formules intérieur et extérieur. Ça coûte combien un intérieur complet ?'],
    ['PRICE_QUOTE', 'Bonjour, j’ai vu que vous intervenez à domicile. C’est combien pour un véhicule ?'],
    ['PRICE_QUOTE', 'Bonjour, j’ai vu vos prestations, je connaissais mal. Je peux avoir un devis rapidement ?'],
    ['PRICE_QUOTE', 'Bonjour, j’ai vu vos formules. Vous prenez combien pour un reportage complet ?'],
    ['AVAILABILITY', 'Bonjour, j’ai vu que vous intervenez à domicile. Vous avez de la dispo cette semaine ?'],
    ['AVAILABILITY', 'Bonjour, j’ai vu vos prestations premium. Quel délai pour une intervention ?'],
    ['AVAILABILITY', 'Bonjour, j’ai vu que vous lavez à la main. Vous travaillez le samedi aussi ?'],
    ['JOB_LOGISTICS', 'Bonjour, j’ai vu que vous intervenez à domicile. Ça prend combien de temps une prestation ?'],
    ['JOB_LOGISTICS', 'Bonjour, j’ai vu que vous vous déplacez. Vous venez avec tout le matériel ?'],
    ['COVERAGE', 'Bonjour, j’ai vu que vous lavez sans eau, je connaissais mal. Vous venez jusqu’à Caen ?'],
    ['COVERAGE', 'Bonjour, j’ai vu vos prestations à domicile. Vous vous déplacez jusqu’où exactement ?'],
    ['ELIGIBILITY', 'Bonjour, j’ai vu vos formules, je connaissais mal ce format. Vous acceptez les utilitaires ?'],
    ['ELIGIBILITY', 'Bonjour, j’ai vu que vous faites l’intérieur. Vous faites aussi les motos ?'],
    ['PREREQUISITE', 'Bonjour, j’ai vu que vous lavez sans eau, je trouve ça malin. Il faut prévoir une place couverte ?'],
  ];

  it('chacune est reconnue, et sur la famille attendue', () => {
    for (const [family, body] of ACHETEUR) {
      expect(families(body), body).toContain(family);
      expect(blocking(body), body).toContain('BUYER_ROLE_QUESTION');
    }
  });

  /**
   * La portée est le MESSAGE et non la question : « je cherche quelqu'un pour
   * ma voiture » a déjà posé le rôle avant qu'aucune question ne soit écrite.
   */
  it('un bien ou une intention à la première personne suffisent, sans question', () => {
    const propre = 'Bonjour, j’ai vu que vous intervenez à domicile, je cherche quelqu’un pour ma voiture. Vous fonctionnez comment ?';
    expect(families(propre)).toEqual(expect.arrayContaining(['OWN_PROPERTY', 'PURCHASE_INTENT']));
    expect(blocking(propre)).toContain('BUYER_ROLE_INTENT');
  });
});

// ---------------------------------------------------------------------------
// 4 — l'espace VOULU
// ---------------------------------------------------------------------------

describe('4 — la curiosité d’entreprise passe', () => {
  /**
   * Les deux premières sont les formes citées par la mission. Ce sont des
   * exemples de REGISTRE : le test vérifie qu'elles sont admissibles, jamais
   * qu'elles sont produites.
   */
  const CURIEUSES: readonly string[] = [
    'Bonjour, j’ai vu que vous intervenez à domicile, je croise assez peu ce fonctionnement. Vous avez toujours travaillé comme ça ou c’est venu avec le temps ?',
    'Bonjour, j’ai vu que votre site s’adresse aux particuliers et aux pros, c’est une combinaison que je vois assez peu. Vous avez commencé avec les deux dès le départ ?',
    'Bonjour, j’ai vu que vous faites du portrait en lumière naturelle, je connaissais mal le principe. C’est vous qui vous déplacez ou les gens viennent à vous ?',
    'Bonjour, j’ai vu que vous proposez du tirage sur papier fibre, je vois ça moins souvent qu’avant. Vous travaillez surtout avec des particuliers ?',
    'Bonjour, j’ai vu que vous faites l’intérieur et l’extérieur, je trouve ça plutôt complet. C’est l’intérieur qui revient le plus souvent ?',
    'Bonjour, j’ai vu que vous proposez aussi du premium, je connaissais mal cette différence. Vous l’avez ajouté après ou dès le début ?',
    'Bonjour, j’ai vu que vous travaillez avec des professionnels, je vois ça assez peu. Ça a changé votre façon de vous organiser ?',
    'Bonjour, j’ai vu que vous intervenez à domicile, je trouve le principe plutôt malin. Vous travaillez aussi avec des professionnels ?',
  ];

  it('aucune n’est prise pour la question d’un client', () => {
    for (const body of CURIEUSES) expect(detectBuyerRole(body), body).toEqual([]);
  });

  it('aucune n’est refusée par l’ensemble du contrôle', () => {
    for (const body of CURIEUSES) expect(blocking(body), body).toEqual([]);
  });

  /**
   * Le faux positif que la mesure a réellement produit : sur les 420 messages
   * réels, « quelle zone SOUHAITEZ-VOUS DÉVELOPPER en priorité ? » était
   * attrapé par un motif qui ne regardait que le nom. Le verbe est désormais
   * exigé, et cette question — qui porte sur leur ambition, pas sur leur
   * rayon — repasse.
   */
  it('« quelle zone souhaitez-vous développer » n’est pas une vérification de couverture', () => {
    expect(detectBuyerRole('Quelle prestation et quelle zone aimeriez-vous développer en priorité aujourd’hui ?')).toEqual([]);
    expect(detectBuyerRole('Sur quelle zone et pour quel type de client serait-il le plus pertinent d’échanger ?')).toEqual([]);
    // Celle-ci, en revanche, demande bien la couverture.
    expect(families('Quelle zone desservez-vous aujourd’hui ?')).toContain('COVERAGE');
  });

  /**
   * Le discriminant de l'éligibilité est le MODAL, et un seul mot sépare les
   * deux phrases ci-dessous.
   */
  it('« les pros vous confient souvent leurs flottes ? » interroge leur clientèle, pas une commande', () => {
    expect(detectBuyerRole('Les pros vous confient souvent leurs flottes ?')).toEqual([]);
    expect(families('Les pros peuvent vous confier un seul véhicule ?')).toContain('ELIGIBILITY');
  });

  it('« des clients qui demandent un devis » n’est pas une demande de devis', () => {
    expect(detectBuyerRole('Vous avez des clients qui vous demandent un devis avant même de venir ?')).toEqual([]);
  });

  /**
   * HERMES-FIRST-TOUCH-DIVERSITY-R1 — le faux positif que le second rejeu a
   * produit. `quel` n'était borné d'aucun côté dans l'objet de portée, si bien
   * qu'il matchait à l'intérieur de « les-quel-s ». La question porte sur la
   * clientèle, pas sur le rayon.
   */
  it('« pour lesquels ? » n’est pas une vérification de couverture', () => {
    expect(detectBuyerRole('Au quotidien, vous intervenez plutôt pour lesquels ?')).toEqual([]);
    expect(detectBuyerRole('Vous travaillez plutôt pour lesquels ?')).toEqual([]);
    expect(detectBuyerRole('Vous intervenez quelquefois sur des flottes ?')).toEqual([]);
    // Et la couverture reste refusée, des deux formes.
    expect(families('Vous intervenez dans quel secteur ?')).toContain('COVERAGE');
    expect(families('Vous vous déplacez dans quelles communes ?')).toContain('COVERAGE');
  });

  it('un jour de la semaine reste une question de disponibilité, quel que soit le verbe', () => {
    expect(families('Vous intervenez le week-end aussi ?')).toContain('AVAILABILITY');
    expect(families('Vous travaillez le samedi ?')).toContain('AVAILABILITY');
    // Sans jour, le verbe seul ne dit rien.
    expect(detectBuyerRole('Vous intervenez surtout pour des pros ?')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5 — la structure en trois temps survit
// ---------------------------------------------------------------------------

describe('5 — observation → réaction → curiosité d’entreprise', () => {
  const TROIS_TEMPS =
    'Bonjour, j’ai vu que vous intervenez à domicile, je croise assez peu ce fonctionnement. ' +
    'Vous avez toujours travaillé comme ça ou c’est venu avec le temps ?';

  it('la structure entière passe, ancrage compris', () => {
    const report = checkFirstTouch({ body: TROIS_TEMPS, groundedFacts: FACTS });
    expect(report.findings.filter((finding) => finding.severity === 'BLOCKING')).toEqual([]);
    expect(report.verdict).toBe('CONVERSATIONAL');
  });

  it('la réaction personnelle n’est toujours pas comptée comme une observation', () => {
    const claims = observationClaims(TROIS_TEMPS, FACTS);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.grounded).toBe(true);
  });

  /**
   * La portée est la clé de tout ce module : la même suite de mots est licite
   * en observation et refusée en question.
   */
  it('la portée est la QUESTION — une observation de couverture reste licite', () => {
    const observation = 'Bonjour, j’ai vu que vous intervenez jusqu’à Caen, je connaissais mal. Vous avez toujours fait comme ça ?';
    expect(interrogativeSpans(observation)).toEqual(['Vous avez toujours fait comme ça ?']);
    expect(detectBuyerRole(observation)).toEqual([]);

    const question = 'Bonjour, j’ai vu que vous lavez sans eau, je connaissais mal. Vous intervenez jusqu’à Caen ?';
    expect(families(question)).toContain('COVERAGE');
  });
});

// ---------------------------------------------------------------------------
// 6 — l'ancrage factuel n'a pas bougé
// ---------------------------------------------------------------------------

describe('6 — aucune régression sur l’ancrage', () => {
  it('une question peut porter sur ce qu’on IGNORE, l’observation reste sourcée', () => {
    // L'histoire de l'entreprise n'est dans aucun fait. La DEMANDER est licite ;
    // l'AFFIRMER ne l'est pas.
    const demande = 'Bonjour, j’ai vu que vous intervenez à domicile. Vous avez toujours travaillé comme ça ?';
    expect(blocking(demande)).toEqual([]);

    const affirmation = 'Bonjour, j’ai vu que vous êtes installés depuis 2019, je trouve ça malin. Vous continuez comme ça ?';
    expect(blocking(affirmation)).toContain('UNGROUNDED_OBSERVATION');
  });

  it('une observation non portée par un fait reste refusée', () => {
    const inventé = 'Bonjour, j’ai vu que vous posez du des tirages grand format sur toile, je connaissais mal. Vous avez commencé par là ?';
    expect(blocking(inventé)).toContain('UNGROUNDED_OBSERVATION');
  });

  it('sans aucun fait, rien n’est reproché ni exigé', () => {
    const générique = 'Bonjour, je découvre votre compte. Vous travaillez surtout avec des particuliers ?';
    expect(blocking(générique, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7 — les gardes de naturalité n'ont pas été desserrées
// ---------------------------------------------------------------------------

describe('7 — aucune garde de naturalité n’a bougé', () => {
  const REFUSÉS: ReadonlyArray<readonly [FirstTouchCode, string]> = [
    ['UNSOLICITED_ADVICE', 'Bonjour, j’ai vu votre travail. Une piste serait de distinguer les demandes par prestation, non ?'],
    ['LANDING_PAGE_ADVICE', 'Bonjour, j’ai vu votre site. Vous avez pensé à une page dédiée à une seule prestation ?'],
    ['ATTRIBUTION_JARGON', 'Bonjour, j’ai vu votre compte. Vous suivez vos leads par canal d’acquisition ?'],
    ['PERFORMANCE_OFFER', 'Bonjour, j’ai vu votre travail. On peut tester gratuitement, ça vous irait ?'],
    ['IMMEDIATE_CALL_CTA', 'Bonjour, j’ai vu votre travail, c’est propre. On se cale un appel de quinze minutes ?'],
    ['FULL_PITCH', 'Bonjour, on aide les detailers à avoir plus de demandes. Ça vous parle ?'],
    ['CORPORATE_JARGON', 'Bonjour, dans le cadre de notre démarche, seriez-vous disponible pour en parler ?'],
  ];

  it('chaque refus historique refuse encore, à l’identique', () => {
    for (const [code, body] of REFUSÉS) expect(blocking(body), body).toContain(code);
  });

  it('une seule question, toujours — la garde n’a pas été contournée', () => {
    const deux = 'Bonjour, j’ai vu que vous intervenez à domicile. Vous avez toujours fait comme ça ? Et vous travaillez avec des pros ?';
    expect(blocking(deux)).toContain('MULTIPLE_QUESTIONS');
  });

  it('aucune question du tout reste refusé — une réponse est le but', () => {
    const muet = 'Bonjour, j’ai vu que vous intervenez à domicile, je croise assez peu ce fonctionnement.';
    expect(blocking(muet)).toContain('NO_QUESTION');
  });

  /**
   * Le gold set est la voix validée. Ce round ne doit RIEN lui reprocher de
   * nouveau : ce qu'il porte est une question de qualification, jamais une
   * question de client.
   */
  it('la voix que l’on VEUT écrire ne devient pas coupable de rôle', () => {
    // Trois messages en trois temps, de familles différentes. La garde doit
    // les laisser passer : elle cherche la posture d'un ACHETEUR, pas une
    // question polie.
    const VOIX: readonly string[] = [
      'Bonjour, j’ai vu que vous travaillez avec des particuliers et des pros, ' +
        'c’est une combinaison que je vois assez peu. C’est plutôt les uns ou les autres au quotidien ?',
      'Bonjour, j’ai vu que vos tarifs sont affichés en ligne, je trouve ça plutôt rare. ' +
        'Vous avez toujours fonctionné comme ça ?',
      'Bonjour, j’ai vu que vous intervenez à domicile, je connaissais mal ce fonctionnement. ' +
        'C’est ce qui vous prend le plus de temps ?',
    ];
    for (const body of VOIX) {
      expect(detectBuyerRole(body), body).toEqual([]);
    }
  });

  /**
   * L'invariant que CLAUDE.md exige de chaque round : la fonction ne reçoit
   * qu'un texte, donc il n'existe aucune donnée depuis laquelle une exception
   * pourrait être écrite.
   */
  it('aucune exception nominative, et aucune n’est écrivable', async () => {
    const source = await readFile('src/lib/pipeline/firstTouchSenderRole.ts', 'utf-8');
    // La preuve n'est pas l'absence d'un mot dans un commentaire : c'est que le
    // module n'a AUCUN moyen d'apprendre de qui il parle — ni prospect, ni
    // compte, ni campagne, ni configuration. Une seule importation, et elle ne
    // porte qu'une normalisation typographique.
    const imports = [...source.matchAll(/^import .*$/gmu)].map((match) => match[0]);
    expect(imports).toEqual(["import { normalizeForMatching } from '@/lib/conversation/text';"]);
    // Et sa seule entrée publique ne reçoit qu'une chaîne.
    expect(source).toMatch(/export function detectBuyerRole\(body: string\)/);
    expect(source).toMatch(/export function interrogativeSpans\(body: string\)/);
  });
});
