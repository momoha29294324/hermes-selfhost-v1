import { describe, expect, it } from 'vitest';
import {
  BUMP_SLACK_MS,
  classifyInbox,
  MIN_INBOX_ROWS,
  parseRelativeAgeMs,
  UNKNOWN_INBOX_WITNESS,
  UNREADABLE_INBOX_READ,
  wasThreadBumped,
  type InboxRowMeasure,
  type RawInboxRead,
} from '@/lib/instagram/inboxScan';

/**
 * IG2.4 — la boîte de réception, éprouvée sur le cas exact qui l'a mise en
 * défaut.
 *
 * Le 14 août, l'adjudication a conclu « aucune conversation avec
 * `operator_second_account` » et en a tiré `DELIVERY_FAILED`. La capture montre l'inverse :
 * la ligne « Moha » est en tête des Messages, aperçu
 * `https://id-preview--f8c00bcf-1639-…`, datée « 11 sem. ».
 *
 * Ce fichier fige les deux choses à la fois : que cette absence était fausse, et
 * que la vraie preuve — un fil présent mais NON REMONTÉ — dit la même issue pour
 * une raison, elle, vérifiable.
 */

const HANDLE = 'operator_second_account';
const DISPLAY = 'Moha';
const APPROVED = 'Test technique Hermes — aucun suivi nécessaire.';
const PREFIX = APPROVED.slice(0, 40);

/** Le dernier segment d'une ligne — ce que le nœud de date affiche, et lui seul. */
function timeLabelOf(text: string): string | null {
  const parts = text.split('·');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const trimmed = last === undefined ? '' : last.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Une ligne mesurée.
 *
 * `timeLabel` est DÉRIVÉ du texte comme l'interface le fait : la date vit dans
 * son propre nœud, séparée de l'aperçu. Depuis IG5 R2 c'est la seule entrée de
 * l'âge — le corps du message n'en est plus une.
 */
function row(index: number, text: string, over: Partial<InboxRowMeasure> = {}): InboxRowMeasure {
  return {
    index,
    threadId: null,
    text,
    timeLabel: timeLabelOf(text),
    imageAlts: [],
    ariaLabels: [],
    rect: { left: 96, right: 456, top: 300 + index * 72, bottom: 372 + index * 72 },
    ...over,
  };
}

/** La boîte réellement observée, ligne pour ligne. */
const OBSERVED_ROWS: readonly InboxRowMeasure[] = [
  row(0, 'Moha https://id-preview--f8c00bcf-1639-… · 11 sem.'),
  row(1, 'Utilisateur Instagram Je t’ai appelé plusieurs fois si tu répo… · 22 sem.'),
  row(2, 'Petit loup🐺 Bonsoir, plutôt · 49 sem.'),
  row(3, 'Kilo Moralex Tu ne lui répond pas ? · 49 sem.'),
  row(4, 'Valentin Guionnière Servel On peut s’ajouter sur shotgun si c’e… · 49 sem.'),
];

function read(over: Partial<RawInboxRead> = {}): RawInboxRead {
  return {
    listFound: true,
    rows: OBSERVED_ROWS,
    avatarCount: 13,
    visibleTextLength: 868,
    viewerLabel: 'hermesagency_',
    ...over,
  };
}

function classify(over: Partial<RawInboxRead> = {}, displayName: string | null = DISPLAY) {
  return classifyInbox({
    read: read(over),
    expectedHandle: HANDLE,
    expectedDisplayName: displayName,
    approvedPrefix: PREFIX,
  });
}

// ---------------------------------------------------------------------------
// Lisibilité
// ---------------------------------------------------------------------------

describe('IG2.4 — INBOX_READABLE / INBOX_UNREADABLE', () => {
  it('le cas du 14 août : zéro ligne comprise ⇒ illisible, jamais une absence', () => {
    // Treize vignettes et 868 caractères — les deux mesures qui faisaient
    // déclarer la liste « rendue » — mais aucune ligne lue.
    const witness = classify({ listFound: false, rows: [] });
    expect(witness.readability).toBe('INBOX_UNREADABLE');
    expect(witness.presence).toBe('THREAD_UNKNOWN');
    expect(witness.detail).toContain('aucune absence');
  });

  it('une liste partiellement rendue reste illisible', () => {
    expect(classify({ rows: OBSERVED_ROWS.slice(0, MIN_INBOX_ROWS - 1) }).readability).toBe('INBOX_UNREADABLE');
    expect(classify({ rows: OBSERVED_ROWS.slice(0, MIN_INBOX_ROWS) }).readability).toBe('INBOX_READABLE');
  });

  it('une lecture qui a échoué rend le témoin d’ignorance', () => {
    const witness = classifyInbox({
      read: UNREADABLE_INBOX_READ,
      expectedHandle: HANDLE,
      expectedDisplayName: DISPLAY,
      approvedPrefix: PREFIX,
    });
    expect(witness.readability).toBe(UNKNOWN_INBOX_WITNESS.readability);
    expect(witness.presence).toBe('THREAD_UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
// Présence
// ---------------------------------------------------------------------------

describe('IG2.4 — THREAD_PRESENT / THREAD_NOT_FOUND', () => {
  it('reconnaît « Moha » par le nom d’affichage CORROBORÉ', () => {
    const witness = classify();
    expect(witness.presence).toBe('THREAD_PRESENT');
    expect(witness.row?.basis).toBe('corroborated_display_name');
    expect(witness.row?.index).toBe(0);
  });

  it('sans corroboration, le nom d’affichage ne reconnaît rien', () => {
    // « Moha » sans savoir que Moha EST operator_second_account ouvrirait la conversation
    // de n'importe quel homonyme.
    const witness = classify({}, null);
    expect(witness.presence).toBe('THREAD_NOT_FOUND');
    expect(witness.detail).toContain('non corroboré');
  });

  it('le handle dans la ligne reste le signal fort', () => {
    const witness = classify({
      rows: [row(0, `${HANDLE} salut · 3 j`), ...OBSERVED_ROWS.slice(1)],
    }, null);
    expect(witness.row?.basis).toBe('handle_token');
  });

  it('le handle dans un alt d’image compte aussi', () => {
    const witness = classify(
      {
        rows: [
          row(0, 'Quelqu’un · 3 j', { imageAlts: [`Photo de profil de ${HANDLE}`] }),
          ...OBSERVED_ROWS.slice(1),
        ],
      },
      null,
    );
    expect(witness.row?.basis).toBe('image_alt_handle');
  });

  it('THREAD_NOT_FOUND uniquement sur une liste réellement lue', () => {
    const absent = classify({ rows: OBSERVED_ROWS.slice(1) });
    expect(absent.readability).toBe('INBOX_READABLE');
    expect(absent.presence).toBe('THREAD_NOT_FOUND');
  });

  it('deux lignes candidates ne se départagent pas toutes seules', () => {
    const witness = classify({
      rows: [row(0, 'Moha a · 1 j'), row(1, 'Moha b · 2 j'), ...OBSERVED_ROWS.slice(2)],
    });
    expect(witness.ambiguous).toBe(true);
    expect(witness.row).toBeNull();
  });

  it('un homonyme partiel n’est pas la cible', () => {
    const witness = classify({
      rows: [row(0, 'un opérateur Bonsoir · 1 j'), ...OBSERVED_ROWS.slice(1)],
    });
    expect(witness.presence).toBe('THREAD_NOT_FOUND');
  });
});

describe('IG2.4 — la note n’est pas une conversation', () => {
  it('une tuile étroite du carrousel « Notes » ne compte pas comme ligne', () => {
    // Observé le 14 août : le carrousel de notes porte lui aussi une vignette
    // « Moha », de la même hauteur qu'une ligne. Sans la borne de largeur, la
    // note et la conversation faisaient deux candidates et le scanner refusait
    // de trancher — une ambiguïté qu'il avait lui-même fabriquée.
    const noteTile = row(0, 'Moha', { rect: { left: 200, right: 296, top: 168, bottom: 240 } });
    const conversation = row(1, 'Moha https://id-preview--f8c00bcf-1639-… · 11 sem.');
    const witness = classifyInbox({
      read: {
        listFound: true,
        // La tuile est absente des lignes : la page ne la mesure plus comme
        // telle. Ce test décrit ce que la classification doit voir arriver.
        rows: [conversation, ...OBSERVED_ROWS.slice(1, 4)],
        avatarCount: 13,
        visibleTextLength: 868,
        viewerLabel: 'hermesagency_',
      },
      expectedHandle: HANDLE,
      expectedDisplayName: DISPLAY,
      approvedPrefix: PREFIX,
    });
    expect(witness.ambiguous).toBe(false);
    expect(witness.presence).toBe('THREAD_PRESENT');
    expect(noteTile.rect.right - noteTile.rect.left).toBeLessThan(200);
  });

  it('deux vraies conversations homonymes restent une ambiguïté', () => {
    const witness = classify({
      rows: [row(0, 'Moha a · 1 j'), row(1, 'Moha b · 2 j'), ...OBSERVED_ROWS.slice(2)],
    });
    expect(witness.ambiguous).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fraîcheur
// ---------------------------------------------------------------------------

describe('IG2.4 — la fraîcheur affichée', () => {
  it('lit les unités françaises et anglaises', () => {
    expect(parseRelativeAgeMs('Moha … · 11 sem.')).toBe(11 * 7 * 24 * 3600_000);
    expect(parseRelativeAgeMs('Moha … · 3 j')).toBe(3 * 24 * 3600_000);
    expect(parseRelativeAgeMs('Moha … · 2 h')).toBe(2 * 3600_000);
    expect(parseRelativeAgeMs('Moha … · 45 min')).toBe(45 * 60_000);
    expect(parseRelativeAgeMs('Moha … · 2 w')).toBe(2 * 7 * 24 * 3600_000);
    expect(parseRelativeAgeMs('Moha … · Maintenant')).toBe(0);
    expect(parseRelativeAgeMs('Moha … · now')).toBe(0);
  });

  it('refuse une unité ambiguë plutôt que de la deviner', () => {
    // « 5 m » : cinq minutes en anglais, rien en français. Trancher au hasard
    // se tromperait d'un facteur quatre mille.
    expect(parseRelativeAgeMs('Moha … · 5 m')).toBeNull();
    expect(parseRelativeAgeMs('aucun horodatage ici')).toBeNull();
  });

  it('retient le DERNIER jeton temporel — l’aperçu peut contenir des chiffres', () => {
    expect(parseRelativeAgeMs('Moha rendez-vous à 3 h du matin · 11 sem.')).toBe(11 * 7 * 24 * 3600_000);
  });

  it('un fil vieux de 11 semaines n’a pas été remonté par un envoi d’il y a 15 min', () => {
    const witness = classify();
    expect(wasThreadBumped(witness.row, 15 * 60_000)).toBe(false);
  });

  it('un fil « Maintenant » a bien été remonté', () => {
    const witness = classify({ rows: [row(0, `Moha Vous: ${APPROVED} · Maintenant`), ...OBSERVED_ROWS.slice(1)] });
    expect(wasThreadBumped(witness.row, 15 * 60_000)).toBe(true);
    expect(witness.row?.previewMatchesApproved).toBe(true);
  });

  it('l’arrondi d’Instagram est absorbé, pas onze semaines', () => {
    const rounded = classify({ rows: [row(0, 'Moha … · 1 h'), ...OBSERVED_ROWS.slice(1)] });
    expect(wasThreadBumped(rounded.row, 3 * 60_000)).toBe(true);
    expect(BUMP_SLACK_MS).toBe(3600_000);
  });

  it('un horodatage illisible ne conclut rien', () => {
    const witness = classify({ rows: [row(0, 'Moha aperçu sans date'), ...OBSERVED_ROWS.slice(1)] });
    expect(witness.row?.ageMs).toBeNull();
    expect(wasThreadBumped(witness.row, 15 * 60_000)).toBeNull();
  });
});
