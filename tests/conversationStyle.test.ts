import { describe, expect, it } from 'vitest';
import {
  EMPTY_STYLE_PROFILE,
  buildStyleProfile,
  type StyleProfile,
  type StyleSample,
} from '@/lib/conversation/style';
import { normalizeForMatching } from '@/lib/conversation/text';
import { HERMES_VOICE, STYLE_LIMITS, renderStyleDirective } from '@/lib/conversation/voice';

/**
 * CONVERSATION-R1 §18 — le profil de style et ses limites d'adaptation.
 *
 * Aucun modèle n'intervient : tout ce qui est vérifié ici est du code
 * déterministe. C'est délibéré. « Hermes répond en tutoyant » n'est pas
 * testable sur une sortie de modèle sans devenir un test instable ; ce qui est
 * testable, et ce qui GOUVERNE réellement la réponse, c'est la consigne
 * produite. On teste donc le contrat que le code contrôle, pas une espérance
 * statistique sur un texte généré.
 *
 * Les messages sont fictifs. Rien d'un échange réel n'entre dans ce dépôt.
 */

function samples(...texts: readonly string[]): StyleSample[] {
  // Une heure entre chaque message : des tours distincts, pas une rafale.
  return texts.map((text, index) => ({
    text,
    at: new Date(Date.UTC(2026, 7, 20, 9 + index, 0, 0)).toISOString(),
  }));
}

describe('§18.1 — un premier message court ne fonde pas un profil', () => {
  it('rend une confiance LOW', () => {
    const profile = buildStyleProfile(samples('ok'));
    expect(profile.confidence).toBe('LOW');
    expect(profile.observedMessages).toBe(1);
  });

  it('ne prétend pas que la personne n’utilise pas d’emoji', () => {
    // L'absence d'emoji dans « ok » n'est pas une observation : c'est une
    // absence non vérifiée, et l'affirmer violerait la règle 2 de CLAUDE.md.
    const profile = buildStyleProfile(samples('ok'));
    expect(profile.emojiLevel).toBe('UNKNOWN');
  });

  it('rend le profil vide quand il n’y a rien à lire', () => {
    expect(buildStyleProfile([])).toEqual(EMPTY_STYLE_PROFILE);
    expect(buildStyleProfile(samples('   '))).toEqual(EMPTY_STYLE_PROFILE);
  });
});

describe('§18.2 — la confiance monte avec la matière observée', () => {
  it('passe de LOW à MEDIUM puis HIGH', () => {
    const one = buildStyleProfile(samples('salut, ça donne quoi votre truc ?'));
    const few = buildStyleProfile(
      samples('salut, ça donne quoi votre truc ?', 'ouais je vois, et concrètement vous faites quoi ?'),
    );
    const many = buildStyleProfile(
      samples(
        'salut, ça donne quoi votre truc ?',
        'ouais je vois, et concrètement vous faites quoi ?',
        'ok mais moi je bosse surtout avec des habitués du coin franchement',
        'du coup ça change quoi pour moi au quotidien, faut que je fasse quelque chose ?',
      ),
    );

    expect(one.confidence).toBe('LOW');
    expect(few.confidence).toBe('MEDIUM');
    expect(many.confidence).toBe('HIGH');
  });
});

describe('§18.3 / §18.4 — le registre se lit, il ne se devine pas', () => {
  it('reprend le tutoiement quand la personne tutoie', () => {
    const profile = buildStyleProfile(samples('salut, tu fais quoi exactement ? toi tu bosses avec qui ?'));
    expect(profile.addressMode).toBe('TU');
    expect(renderStyleDirective(profile)).toContain('Tutoie');
  });

  it('reprend le vouvoiement quand la personne vouvoie', () => {
    const profile = buildStyleProfile(samples('Bonjour, que proposez-vous exactement ? Votre offre m’intrigue.'));
    expect(profile.addressMode).toBe('VOUS');
    expect(renderStyleDirective(profile)).toContain('Vouvoie');
  });

  it('reste UNKNOWN — et n’impose aucun registre — quand rien ne le dit', () => {
    const profile = buildStyleProfile(samples('ok'));
    expect(profile.addressMode).toBe('UNKNOWN');
    const directive = renderStyleDirective(profile);
    expect(directive).not.toContain('Tutoie');
    expect(directive).not.toContain('Vouvoie');
  });

  it('lit le registre dès le premier message, même sous confiance LOW', () => {
    // Le registre est le seul trait qu'un unique message suffit à observer :
    // « tu » est écrit, ce n'est pas une habitude à confirmer.
    const profile = buildStyleProfile(samples('tu fais quoi ?'));
    expect(profile.confidence).toBe('LOW');
    expect(renderStyleDirective(profile)).toContain('Tutoie');
  });
});

describe('§18.5 — les emojis s’adaptent, ils ne se surenchérissent pas', () => {
  it('interdit l’emoji quand la personne n’en met aucun', () => {
    const profile = buildStyleProfile(
      samples('Bonjour, je serais intéressé par vos services.', 'Pouvez-vous me préciser votre approche ?'),
    );
    expect(profile.emojiLevel).toBe('NONE');
    expect(renderStyleDirective(profile)).toContain('N’utilise aucun emoji');
  });

  it('plafonne à UN emoji même face à quelqu’un qui en met partout', () => {
    const profile = buildStyleProfile(
      samples('yo 🔥🔥 ça déchire 😍', 'grave 😂😂 trop bien 🚀🚀', 'carrément 💪💪 top 🙌'),
    );
    expect(profile.emojiLevel).toBe('HIGH');
    const directive = renderStyleDirective(profile);
    expect(directive).toContain('Au plus UN emoji');
    expect(directive).toContain('ne t’aligne pas sur la quantité');
    expect(directive).toContain('ne surjoue pas les emojis');
  });
});

describe('§18.6 / §18.7 — longueur et formalité', () => {
  it('demande une réponse très courte à quelqu’un de très bref', () => {
    const profile = buildStyleProfile(samples('combien ?', 'ok', 'et sinon ?', 'pk pas'));
    expect(profile.avgLength).toBe('VERY_SHORT');
    expect(renderStyleDirective(profile)).toContain('très court');
  });

  it('ne demande pas une réponse courte quand la personne développe', () => {
    const profile = buildStyleProfile(
      samples(
        'Bonjour, je vous remercie pour votre message. Nous travaillons principalement avec une clientèle locale fidélisée depuis plusieurs années, et nous nous interrogeons régulièrement sur la pertinence d’un canal d’acquisition complémentaire.',
        'Je précise que nous avons déjà tenté une démarche de ce type par le passé, sans obtenir le résultat escompté, ce qui explique une certaine prudence de notre part aujourd’hui.',
      ),
    );
    // Deux messages d'environ 230 caractères en moyenne : « mesuré », pas
    // « long ». Ce qui compte est qu'aucune consigne de brièveté ne parte.
    expect(profile.avgLength).toBe('MEDIUM');
    expect(renderStyleDirective(profile)).not.toContain('très court');
    expect(renderStyleDirective(profile)).toContain('mesurée');
  });

  it('monte en formalité face à quelqu’un de formel', () => {
    const profile = buildStyleProfile(
      samples(
        'Bonjour Monsieur, je vous remercie de votre message et vous prie de bien vouloir me préciser votre offre.',
        'Dans l’attente de votre retour, je vous adresse mes sincères salutations.',
      ),
    );
    expect(profile.formality).toBe('FORMAL');
    expect(renderStyleDirective(profile)).toContain('soutenu');
  });

  it('descend en registre face à quelqu’un de détendu', () => {
    const profile = buildStyleProfile(samples('salut ! franchement ça peut être cool', 'ouais carrément, du coup ?'));
    expect(profile.formality).toBe('CASUAL');
    expect(renderStyleDirective(profile)).toContain('détendu');
  });
});

describe('§18.8 — les fautes ne se recopient jamais', () => {
  it('interdit explicitement la reproduction des fautes', () => {
    const profile = buildStyleProfile(
      samples('slt jvoudré savoir cé combien vos truk pcq jai pa bcp de tps', 'ct pour savoir si sa vo le coup'),
    );
    const directive = renderStyleDirective(profile);
    expect(directive).toContain('ne reproduis JAMAIS les fautes');
    expect(directive).toContain('écris correctement');
  });

  it('n’expose aucune dimension « fautes » qu’un rédacteur pourrait imiter', () => {
    // Le profil observe des abréviations (un registre), jamais une orthographe
    // à reproduire. La nuance est ce qui sépare l'adaptation de la caricature.
    const profile = buildStyleProfile(samples('slt pk pa, jsp bcp sur le sujet tkt'));
    expect(profile.abbreviations).toBe('HEAVY');
    expect(Object.keys(profile)).not.toContain('typos');
    expect(Object.keys(profile)).not.toContain('spelling');
  });

  it('n’imite jamais l’hostilité', () => {
    expect(STYLE_LIMITS).toContain('n’imite jamais une insulte');
  });

  it('ne laisse jamais croire que Hermes EST la personne', () => {
    expect(STYLE_LIMITS).toContain('ne laisse jamais croire que tu ES cette personne');
  });
});

describe('§18.18 — aucun trait sensible n’entre dans le profil', () => {
  const FORBIDDEN = [
    'age',
    'âge',
    'gender',
    'genre',
    'origin',
    'origine',
    'ethnicity',
    'nationality',
    'nationalité',
    'personality',
    'personnalité',
    'socialClass',
    'education',
    'religion',
    'politique',
    'health',
    'santé',
    'income',
    'revenu',
  ];

  it('ne porte que des dimensions linguistiques', () => {
    const profile = buildStyleProfile(
      samples('salut ! tu fais quoi exactement ? 😊', 'ok cool, et le budget ça donne quoi ?'),
    );
    const keys = Object.keys(profile).map((key) => key.toLowerCase());
    for (const forbidden of FORBIDDEN) {
      expect(keys).not.toContain(forbidden.toLowerCase());
    }
    expect(keys.sort()).toEqual(
      [
        'abbreviations',
        'addressmode',
        'avglength',
        'confidence',
        'directness',
        'emojilevel',
        'energy',
        'formality',
        'observedchars',
        'observedmessages',
        'punctuation',
        'rhythm',
        'sentenceshape',
        'vocabulary',
      ].sort(),
    );
  });

  it('n’expose que des valeurs d’énumération et des compteurs', () => {
    const profile = buildStyleProfile(samples('salut ! tu fais quoi ? 😊'));
    for (const [key, value] of Object.entries(profile)) {
      if (key === 'observedMessages' || key === 'observedChars') {
        expect(typeof value).toBe('number');
        continue;
      }
      expect(typeof value).toBe('string');
      // Une valeur d'énumération est en MAJUSCULES et sans espace : un
      // fragment de message ne peut pas passer ce filtre.
      expect(value as string).toMatch(/^[A-Z_]+$/);
    }
  });
});

describe('§18.19 — la conversation privée ne se recopie pas dans le profil', () => {
  it('ne conserve aucun fragment du texte observé', () => {
    const secret = 'Mon associé Karim part fin septembre et notre chiffre a chuté de moitié';
    const profile = buildStyleProfile(samples(secret, 'du coup je sais pas quoi faire honnêtement'));
    const serialized = JSON.stringify(profile);

    for (const word of ['Karim', 'associé', 'septembre', 'chiffre', 'chuté', 'moitié']) {
      expect(serialized).not.toContain(word);
    }
    // Ce qui reste du message est un compte de caractères, pas son contenu.
    expect(profile.observedChars).toBeGreaterThan(0);
  });

  it('ne recopie rien non plus dans la consigne envoyée au rédacteur', () => {
    const secret = 'Notre banque nous a refusé un prêt le mois dernier';
    const profile = buildStyleProfile(samples(secret, 'bref, je suis prudent en ce moment'));
    const directive = renderStyleDirective(profile);
    for (const word of ['banque', 'prêt', 'refusé']) {
      expect(directive).not.toContain(word);
    }
  });
});

describe('§8 — la voix Hermes ne disparaît jamais', () => {
  it('reste disponible même sans aucun style observé', () => {
    const directive = renderStyleDirective(EMPTY_STYLE_PROFILE);
    expect(directive).toContain('trop peu d’éléments');
    expect(directive).toContain('voix Hermes');
    expect(HERMES_VOICE).toContain('directe et concise');
    expect(HERMES_VOICE).toContain('pas de pavé');
  });

  it('ne bloque jamais une réponse au motif que le style est inconnu', () => {
    // Le repli §8 n'est pas un refus : c'est une consigne de rechange. La
    // fonction rend toujours un texte exploitable.
    const directive = renderStyleDirective(EMPTY_STYLE_PROFILE);
    expect(directive.length).toBeGreaterThan(0);
    expect(directive).toContain('LIMITES D’ADAPTATION');
  });
});

describe('le profil est une fonction pure', () => {
  it('rend deux fois le même profil pour le même corpus', () => {
    const corpus = samples('salut, tu fais quoi ? 😊', 'ok et le prix alors ?');
    const first: StyleProfile = buildStyleProfile(corpus);
    const second: StyleProfile = buildStyleProfile(corpus);
    expect(first).toEqual(second);
  });
});

describe('la typographie réelle ne fait pas rater une reconnaissance', () => {
  it('lit le tutoiement écrit à l’apostrophe typographique', () => {
    // Les claviers réels (iOS, Instagram mobile, Word) produisent U+2019.
    // Un lexique écrit à l'apostrophe droite échouait en SILENCE sur ces
    // messages — en rendant une valeur plausible plutôt qu'une erreur.
    const droite = buildStyleProfile(samples("salut, t'as déjà testé ce genre de truc ?"));
    const typographique = buildStyleProfile(samples('salut, t’as déjà testé ce genre de truc ?'));

    expect(droite.addressMode).toBe('TU');
    expect(typographique.addressMode).toBe('TU');
    expect(typographique.addressMode).toBe(droite.addressMode);
  });

  it('normalise sans rien retirer au texte', () => {
    expect(normalizeForMatching('j’ai déjà quelqu’un')).toBe("j'ai déjà quelqu'un");
    // Les accents ne sont PAS écrasés : « coût » ne devient pas « cout ».
    expect(normalizeForMatching('coût')).toBe('coût');
  });
});
