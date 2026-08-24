import { stripAccents } from '@/lib/identity/normalize';

/**
 * Deterministic safety net applied to every generated message.
 *
 * The prompts already forbid these things; this file is what makes the ban real.
 * A flagged message is still stored (so it can be reviewed and the prompt fixed)
 * but it is marked, and a `blocking` flag prevents it from being presented as a
 * ready-to-send draft.
 */
export interface GuardrailFlag {
  code: string;
  message: string;
  blocking: boolean;
  excerpt?: string;
}

export interface GuardrailInput {
  body: string;
  maxChars: number;
  /** Verbatim claim the campaign is allowed to make, if any. */
  allowedCaseStudyClaim: string | null;
  /** Numbers that legitimately appear in the allowed claim. */
  allowedNumbers: number[];
  /** Facts the message is allowed to reference (already grounded). */
  groundedFacts: string[];
}

const UNVERIFIED_ABSENCE_PATTERNS: [RegExp, string][] = [
  [/\bvous\s+ne\s+fait?es\s+(?:aucune|pas\s+de|plus\s+de)\s+(?:pub|publicit)/i, 'affirme une absence de publicité non vérifiée'],
  [/\bvous\s+n'?avez\s+(?:pas|aucun|aucune)\s+(?:de\s+)?(?:site|strat[ée]gie|tunnel|funnel|syst[èe]me)/i, 'affirme une absence non vérifiée'],
  [/\bvous\s+ne\s+(?:travaillez|bossez)\s+pas\s+avec/i, 'affirme une absence de prestataire non vérifiée'],
  [/\bpersonne\s+ne\s+vous\s+(?:trouve|voit)/i, 'affirmation invérifiable sur la visibilité'],
  [/\bvous\s+perdez\s+(?:des|de nombreux)\s+clients/i, 'affirme une perte de clients non mesurée'],
];

const FAKE_URGENCY_PATTERNS: [RegExp, string][] = [
  [/derni[èe]re?s?\s+places?/i, 'fausse urgence'],
  [/offre\s+(?:expire|valable\s+jusqu)/i, 'fausse urgence'],
  [/plus\s+que\s+\d+\s+(?:places?|jours?)/i, 'fausse urgence'],
  [/ne\s+reste(?:nt)?\s+(?:plus\s+)?que\s+\d+/i, 'fausse rareté'],
  [/\burgent\b/i, 'ton d’urgence artificielle'],
];

const OVERPROMISE_PATTERNS: [RegExp, string][] = [
  [/\bgaranti[es]?\b/i, 'promesse garantie'],
  [/\b(?:x\s?\d+|\d+\s?x)\s+(?:plus|vos?)\b/i, 'multiplicateur promis'],
  [/\broas\b/i, 'métrique ROAS non fournie'],
  [/\b\d{1,3}\s?%\s*(?:de\s+)?(?:croissance|conversion|retour|augmentation)/i, 'pourcentage de performance non fourni'],
  [/\b(?:doubler|tripler)\s+(?:votre|vos)\b/i, 'promesse de multiplication'],
  [/\bmeilleure?\s+agence\b/i, 'superlatif invérifiable'],
  [/\bleader\b/i, 'superlatif invérifiable'],
];

const PLACEHOLDER_PATTERN = /\[(?:nom|prénom|prenom|entreprise|ville|xx+|à compléter)[^\]]*\]|\{\{[^}]+\}\}/i;

/**
 * Characters outside the Latin script. Observed in practice: a model drifted and
 * emitted CJK mid-sentence in a French text. Harmless-looking, but a message that
 * contains it is unusable and must never reach the review queue as ready.
 */
const FOREIGN_SCRIPT_PATTERN =
  /[Ѐ-ӿ֐-׿؀-ۿ　-〿぀-ヿ一-鿿가-힯]/;

/** Money and metric mentions the message is not allowed to invent. */
export function extractNumbers(text: string): number[] {
  const numbers: number[] = [];
  for (const match of text.matchAll(/(\d[\d\s  .,]{0,12})\s*(?:€|eur\b|euros\b|k€)/gi)) {
    const raw = (match[1] ?? '').replace(/[^\d]/g, '');
    if (!raw) continue;
    const value = Number.parseInt(raw, 10);
    if (Number.isFinite(value)) numbers.push(value);
  }
  return numbers;
}

export function checkMessage(input: GuardrailInput): GuardrailFlag[] {
  const flags: GuardrailFlag[] = [];
  const body = input.body;
  const normalized = stripAccents(body).toLowerCase();

  if (body.trim().length === 0) {
    flags.push({ code: 'empty', message: 'message vide', blocking: true });
    return flags;
  }

  if (body.length > input.maxChars) {
    flags.push({
      code: 'too_long',
      message: `message trop long (${body.length} > ${input.maxChars} caractères)`,
      blocking: false,
    });
  }

  for (const [pattern, label] of UNVERIFIED_ABSENCE_PATTERNS) {
    const match = body.match(pattern);
    if (match) {
      flags.push({ code: 'unverified_absence', message: label, blocking: true, excerpt: match[0] });
    }
  }

  for (const [pattern, label] of FAKE_URGENCY_PATTERNS) {
    const match = body.match(pattern);
    if (match) flags.push({ code: 'fake_urgency', message: label, blocking: true, excerpt: match[0] });
  }

  for (const [pattern, label] of OVERPROMISE_PATTERNS) {
    const match = body.match(pattern);
    if (match) flags.push({ code: 'overpromise', message: label, blocking: true, excerpt: match[0] });
  }

  const foreign = body.match(FOREIGN_SCRIPT_PATTERN);
  if (foreign) {
    flags.push({
      code: 'foreign_script',
      message: 'caractères hors alphabet latin dans un message français',
      blocking: true,
      excerpt: foreign[0],
    });
  }

  // A first message that stops mid-sentence reads as broken automation.
  if (!/[.!?…»)]\s*$/.test(body.trim())) {
    flags.push({
      code: 'truncated',
      message: 'le message ne se termine pas sur une phrase complète',
      blocking: true,
    });
  }

  const placeholder = body.match(PLACEHOLDER_PATTERN);
  if (placeholder) {
    flags.push({
      code: 'placeholder',
      message: 'variable de gabarit non remplie',
      blocking: true,
      excerpt: placeholder[0],
    });
  }

  // A euro amount is quotable when it comes from an approved proof, or when the
  // prospect itself published it and we recorded it as evidence.
  const allowed = new Set(input.allowedNumbers);
  for (const fact of input.groundedFacts) {
    for (const value of extractNumbers(fact)) allowed.add(value);
  }
  for (const value of extractNumbers(body)) {
    if (!allowed.has(value)) {
      flags.push({
        code: 'unapproved_metric',
        message: `montant "${value} €" non issu d'une preuve approuvée`,
        blocking: true,
      });
    }
  }

  if (input.allowedCaseStudyClaim) {
    const mentionsCase = /3\s?500|3500/.test(normalized);
    const claimNormalized = stripAccents(input.allowedCaseStudyClaim).toLowerCase();
    if (mentionsCase) {
      const claimCore = claimNormalized.replace(/[^a-z0-9]/g, '');
      const bodyCore = normalized.replace(/[^a-z0-9]/g, '');
      if (!bodyCore.includes(claimCore.slice(0, Math.min(40, claimCore.length)))) {
        flags.push({
          code: 'case_study_paraphrased',
          message: "la preuve chiffrée doit être citée telle qu'approuvée",
          blocking: true,
        });
      }
    }
  }

  return flags;
}

/** Words too common to prove that a message actually used an observation. */
const COMMON_WORDS = new Set([
  'entreprise', 'societe', 'client', 'clients', 'service', 'services', 'activite',
  'prestation', 'prestations', 'source', 'sources', 'donnees', 'information',
  'informations', 'adresse', 'enregistre', 'enregistree', 'indique', 'presente',
  'notamment', 'egalement', 'aujourd', 'possible', 'pourrait', 'pouvez', 'votre',
  'vous', 'nous', 'avec', 'pour', 'dans', 'leur', 'plus', 'sont', 'cette',
]);

function contentWords(text: string): Set<string> {
  const words = stripAccents(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word.length >= 5 && !COMMON_WORDS.has(word));
  return new Set(words);
}

/**
 * How much of the message is actually built on verified observations.
 *
 * Measured by shared distinctive vocabulary rather than literal quotation: a good
 * message rephrases what was observed ("met en avant la protection boutique en ligne")
 * instead of pasting the evidence line, and the metric has to reward that.
 */
export function personalizationLevel(
  body: string,
  groundedFacts: string[],
): 'none' | 'low' | 'medium' | 'high' {
  if (groundedFacts.length === 0) return 'none';
  const inBody = contentWords(body);
  const shared = new Set<string>();
  for (const fact of groundedFacts) {
    for (const word of contentWords(fact)) {
      if (inBody.has(word)) shared.add(word);
    }
  }
  if (shared.size >= 4) return 'high';
  if (shared.size >= 2) return 'medium';
  if (shared.size === 1) return 'low';
  return 'low';
}
