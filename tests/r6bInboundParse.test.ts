import { describe, expect, it } from 'vitest';
import {
  charsetOf,
  decodeBase64Url,
  extractPlainTextBody,
  flattenTextParts,
  htmlToText,
  toInboundRawMessage,
  GmailMessageShapeError,
  MAX_BODY_CHARS,
  type GmailMessage,
  type GmailMessagePart,
} from '@/lib/inbound/gmailMessage';
import { getHeader, getHeaders, getPlainTextBody } from '@/lib/inbound/mailbox';
import {
  detectAutomationSignals,
  InboundNormalizationError,
  normalizeInboundMessage,
  normalizeSubject,
  parseAddress,
  parseAddressList,
  parseMessageIds,
  parsePlusAddress,
  REPLY_TOKEN_PREFIX,
} from '@/lib/inbound/parse';
import { correlateInbound, type OutboundSend, type ReplyTokenBinding } from '@/lib/inbound/correlation';
import {
  assertReadOnlyScope,
  buildInboxQuery,
  chunkCounterparties,
  gmailDate,
  GMAIL_READONLY_SCOPE,
  GmailScopeError,
  MAX_QUERY_CLAUSE_LENGTH,
} from '@/lib/inbound/gmailProvider';

/**
 * R6B-D1 — les primitives pures de l'ingestion entrante.
 *
 * Aucun test de ce fichier n'ouvre de connexion, ne touche la base, ni ne lit
 * une vraie boîte : tout ce qui est vérifié ici est une fonction déterministe.
 * C'est délibéré — l'extraction d'un corps et la décision de corrélation sont
 * les deux endroits où un système d'ingestion se trompe silencieusement, et
 * une fonction pure est la seule forme qu'on peut exercer sur ses cas limites
 * sans fabriquer un état de boîte pour chacun.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Encodage exact de ce que Gmail renvoie : base64url, sans remplissage. */
export function b64url(text: string, encoding: BufferEncoding = 'utf8'): string {
  return Buffer.from(text, encoding).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function part(mimeType: string, text: string, extra: Partial<GmailMessagePart> = {}): GmailMessagePart {
  return { mimeType, body: { data: b64url(text) }, ...extra };
}

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

describe('decodeBase64Url', () => {
  it('décode l’alphabet URL, avec ou sans remplissage', () => {
    // `~~~?` force `+` et `/` dans un base64 classique, donc `-` et `_` ici :
    // une implémentation qui ne convertirait pas l'alphabet échouerait.
    const source = 'Bonjour ~~~? éàü';
    const encoded = b64url(source);
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(decodeBase64Url(encoded, null)).toBe(source);
    expect(decodeBase64Url(`${encoded}==`, null)).toBe(source);
  });

  it('rend null sur une entrée vide plutôt qu’une chaîne vide', () => {
    // « pas de corps » et « corps vide » ne sont pas le même fait.
    expect(decodeBase64Url('', null)).toBeNull();
  });

  it('respecte le charset annoncé par la partie', () => {
    const latin1 = b64url('réponse', 'latin1');
    expect(decodeBase64Url(latin1, 'iso-8859-1')).toBe('réponse');
    // Le même octet lu en UTF-8 donnerait autre chose : le charset n'est donc
    // pas décoratif.
    expect(decodeBase64Url(latin1, 'utf-8')).not.toBe('réponse');
  });

  it('replie sur UTF-8 devant un charset inconnu plutôt que de perdre le message', () => {
    expect(decodeBase64Url(b64url('bonjour'), 'x-inventé-9000')).toBe('bonjour');
  });

  it('lit le charset dans l’en-tête Content-Type de la partie', () => {
    expect(charsetOf({ headers: [{ name: 'Content-Type', value: 'text/plain; charset="ISO-8859-1"' }] })).toBe(
      'iso-8859-1',
    );
    expect(charsetOf({ headers: [{ name: 'content-type', value: 'text/plain' }] })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Extraction du corps
// ---------------------------------------------------------------------------

describe('extractPlainTextBody', () => {
  it('lit un corps text/plain simple', () => {
    const body = extractPlainTextBody(part('text/plain', 'Bonjour, oui je suis intéressé.'));
    expect(body).toEqual({ text: 'Bonjour, oui je suis intéressé.', source: 'text/plain', truncated: false });
  });

  it('préfère text/plain dans un multipart/alternative', () => {
    const body = extractPlainTextBody({
      mimeType: 'multipart/alternative',
      parts: [part('text/html', '<p>version HTML</p>'), part('text/plain', 'version texte')],
    });
    expect(body.source).toBe('text/plain');
    expect(body.text).toBe('version texte');
  });

  it('descend dans un multipart/mixed imbriqué', () => {
    const body = extractPlainTextBody({
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [part('text/plain', 'le vrai corps'), part('text/html', '<p>ignoré</p>')],
        },
        part('application/pdf', 'binaire', { filename: 'devis.pdf' }),
      ],
    });
    expect(body.source).toBe('text/plain');
    expect(body.text).toBe('le vrai corps');
  });

  it('ne prend jamais une pièce jointe pour le corps', () => {
    // Un `.txt` joint EST du texte — mais ce n'est pas ce que le prospect a
    // écrit, et le confondre ferait passer un fichier pour une réponse.
    const body = extractPlainTextBody({
      mimeType: 'multipart/mixed',
      parts: [part('text/plain', 'contenu du fichier', { filename: 'notes.txt' })],
    });
    expect(body).toEqual({ text: '', source: 'none', truncated: false });
  });

  it('ignore une partie servie uniquement par attachmentId', () => {
    expect(
      flattenTextParts({ mimeType: 'text/plain', body: { attachmentId: 'att-1', size: 42 } }),
    ).toEqual([]);
  });

  it('reconstruit un texte quand aucune partie text/plain n’existe, et le dit', () => {
    const body = extractPlainTextBody({
      mimeType: 'multipart/alternative',
      parts: [part('text/html', '<div>Oui<br>on peut se caller jeudi.</div>')],
    });
    expect(body.source).toBe('text/html');
    expect(body.text).toBe('Oui\non peut se caller jeudi.');
  });

  it('rend un corps vide et « none » quand il n’y a rien de lisible', () => {
    expect(extractPlainTextBody(undefined)).toEqual({ text: '', source: 'none', truncated: false });
    expect(extractPlainTextBody({ mimeType: 'multipart/mixed', parts: [] })).toEqual({
      text: '',
      source: 'none',
      truncated: false,
    });
  });

  it('retient une feuille texte d’un autre sous-type plutôt que rien', () => {
    // Un rapport de non-remise porte souvent sa seule information exploitable
    // dans un `text/rfc822-headers`.
    const body = extractPlainTextBody({
      mimeType: 'multipart/report',
      parts: [part('text/rfc822-headers', 'Final-Recipient: rfc822; inconnu@exemple.fr')],
    });
    expect(body.text).toContain('Final-Recipient');
  });

  it('signale une troncature au lieu de couper en silence', () => {
    const body = extractPlainTextBody(part('text/plain', 'a'.repeat(MAX_BODY_CHARS + 500)));
    expect(body.truncated).toBe(true);
    expect(body.text).toHaveLength(MAX_BODY_CHARS);
  });

  it('normalise les fins de ligne CRLF', () => {
    expect(extractPlainTextBody(part('text/plain', 'une\r\ndeux\rtrois')).text).toBe('une\ndeux\ntrois');
  });
});

describe('htmlToText', () => {
  it('supprime scripts et styles au lieu de rendre leur contenu', () => {
    expect(htmlToText('<style>p{color:red}</style><p>Bonjour</p><script>alert(1)</script>')).toBe('Bonjour');
  });

  it('décode les entités courantes et numériques', () => {
    expect(htmlToText('<p>Caf&eacute; &amp; th&#233;&nbsp;: 5&lt;10</p>')).toBe('Café & thé : 5<10');
  });
});

// ---------------------------------------------------------------------------
// Message complet
// ---------------------------------------------------------------------------

describe('toInboundRawMessage', () => {
  const message: GmailMessage = {
    id: 'gmail-1',
    threadId: 'thread-1',
    historyId: '90210',
    internalDate: '1755036000000',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'Cleanyourcar <contact@exemple.fr>' },
        { name: 'Subject', value: 'Re: Petite question' },
      ],
      body: { data: b64url('oui') },
    },
  };

  it('traduit une ressource Gmail en message neutre', () => {
    const raw = toInboundRawMessage(message);
    expect(raw.providerMessageId).toBe('gmail-1');
    expect(raw.providerThreadId).toBe('thread-1');
    expect(raw.providerHistoryId).toBe('90210');
    expect(raw.internalDateMs).toBe(1_755_036_000_000);
    expect(getPlainTextBody(raw)).toBe('oui');
  });

  it('refuse un message sans identifiant', () => {
    expect(() => toInboundRawMessage({ internalDate: '1' })).toThrow(GmailMessageShapeError);
  });

  it('rend internalDate null quand elle est illisible, sans en inventer une', () => {
    expect(toInboundRawMessage({ ...message, internalDate: 'plus tard' }).internalDateMs).toBeNull();
  });

  it('indexe les en-têtes sans tenir compte de la casse', () => {
    const headers = getHeaders(toInboundRawMessage(message));
    expect(getHeader(headers, 'FROM')).toBe('Cleanyourcar <contact@exemple.fr>');
    expect(getHeader(headers, 'subject')).toBe('Re: Petite question');
    expect(getHeader(headers, 'in-reply-to')).toBeNull();
  });

  it('conserve les occurrences multiples d’un même en-tête', () => {
    const raw = toInboundRawMessage({
      ...message,
      payload: {
        ...message.payload,
        headers: [
          { name: 'Delivered-To', value: 'base@gmail.com' },
          { name: 'Delivered-To', value: 'base+ob_x@gmail.com' },
        ],
      },
    });
    expect(getHeaders(raw).get('delivered-to')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Adresses et identifiants
// ---------------------------------------------------------------------------

describe('parseAddress', () => {
  it('lit les deux formes et normalise la casse', () => {
    expect(parseAddress('Jean <Jean@Exemple.FR>')).toEqual({ address: 'jean@exemple.fr', displayName: 'Jean' });
    expect(parseAddress('  contact@exemple.fr ')).toEqual({ address: 'contact@exemple.fr', displayName: null });
  });

  it('rejette ce qui n’est pas une adresse', () => {
    expect(parseAddress('undisclosed-recipients:;')).toBeNull();
    expect(parseAddress('')).toBeNull();
  });

  it('ne coupe pas un nom d’affichage sur sa virgule', () => {
    // Le piège d'un `split(',')` naïf : deux adresses fabriquées dont aucune
    // n'existe.
    const parsed = parseAddressList(['"Dupont, Jean" <j@ex.fr>, autre@ex.fr']);
    expect(parsed.map((entry) => entry.address)).toEqual(['j@ex.fr', 'autre@ex.fr']);
  });

  it('déduplique une liste', () => {
    expect(parseAddressList(['a@ex.fr, A@EX.FR', 'a@ex.fr'])).toHaveLength(1);
  });
});

describe('parseMessageIds', () => {
  it('extrait tous les identifiants d’un References, chevrons compris', () => {
    // Chevrons conservés : c'est la forme exacte sous laquelle Resend expose
    // `message_id`, donc la seule comparable sans transformation.
    expect(parseMessageIds(['<a@x.fr> <b@y.fr>', '<c@z.fr>'])).toEqual(['<a@x.fr>', '<b@y.fr>', '<c@z.fr>']);
  });

  it('déduplique et ignore ce qui n’est pas un msg-id', () => {
    expect(parseMessageIds(['<a@x.fr> <a@x.fr> pas-un-id'])).toEqual(['<a@x.fr>']);
  });
});

describe('normalizeSubject', () => {
  it('retire les préfixes de réponse empilés, dans plusieurs langues', () => {
    expect(normalizeSubject('Re: RE : Rép: Petite question')).toBe('petite question');
    expect(normalizeSubject('Fwd: Tr: Devis')).toBe('devis');
    expect(normalizeSubject('Re[2]: Devis')).toBe('devis');
  });

  it('réduit les blancs et rend une chaîne vide sur un objet absent', () => {
    expect(normalizeSubject('  Petite   question  ')).toBe('petite question');
    expect(normalizeSubject(null)).toBe('');
  });

  it('ne boucle pas sur un objet forgé', () => {
    expect(normalizeSubject(`${'Re: '.repeat(500)}fin`)).toContain('re:');
  });
});

// ---------------------------------------------------------------------------
// Adresses plus-taguées
// ---------------------------------------------------------------------------

describe('parsePlusAddress', () => {
  const token = 'a1b2c3d4e5f6a7b8';

  it('lit un jeton bien formé', () => {
    expect(parsePlusAddress(`operatoragency+${REPLY_TOKEN_PREFIX}${token}@example.com`)).toEqual({
      ok: true,
      base: 'operatoragency@example.com',
      token,
    });
  });

  it('tolère la casse de l’adresse', () => {
    const parsed = parsePlusAddress(`HermesAgencyy+${REPLY_TOKEN_PREFIX}${token.toUpperCase()}@Gmail.com`);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.token).toBe(token);
  });

  it('distingue une adresse sans tag d’un tag mal formé', () => {
    expect(parsePlusAddress('operatoragency@example.com')).toMatchObject({ ok: false, code: 'not_plus_addressed' });
    expect(parsePlusAddress('operatoragency+facture@example.com')).toMatchObject({ ok: false, code: 'wrong_prefix' });
    expect(parsePlusAddress(`operatoragency+${REPLY_TOKEN_PREFIX}court@example.com`)).toMatchObject({
      ok: false,
      code: 'malformed_token',
    });
    expect(parsePlusAddress(`operatoragency+${REPLY_TOKEN_PREFIX}AVEC-TIRETS-INTERDITS@example.com`)).toMatchObject({
      ok: false,
      code: 'malformed_token',
    });
  });
});

// ---------------------------------------------------------------------------
// Indices d'automatisation
// ---------------------------------------------------------------------------

describe('detectAutomationSignals', () => {
  function headersOf(entries: readonly (readonly [string, string])[]): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const [name, value] of entries) {
      const key = name.toLowerCase();
      map.set(key, [...(map.get(key) ?? []), value]);
    }
    return map;
  }

  it('observe un rapport de non-remise sans le classer', () => {
    const signals = detectAutomationSignals(
      headersOf([
        ['Content-Type', 'multipart/report; report-type=delivery-status; boundary=x'],
        ['Return-Path', '<>'],
      ]),
      'mailer-daemon@googlemail.com',
    );
    // Des faits observés, pas une étiquette « bounce » : la classification
    // commerciale n'appartient pas à cette mission (§10).
    expect(signals).toContain('multipart_report');
    expect(signals).toContain('delivery_status_report');
    expect(signals).toContain('null_return_path');
    expect(signals).toContain('system_sender:mailer-daemon');
    expect(signals.join(' ')).not.toContain('bounce');
  });

  it('observe une réponse automatique d’absence', () => {
    const signals = detectAutomationSignals(
      headersOf([
        ['Auto-Submitted', 'auto-replied; owner'],
        ['X-Autoreply', 'yes'],
      ]),
      'contact@exemple.fr',
    );
    expect(signals).toContain('auto_submitted:auto-replied');
    expect(signals).toContain('auto_reply_header');
  });

  it('ne signale rien sur une vraie réponse humaine', () => {
    expect(detectAutomationSignals(headersOf([['Subject', 'Re: Petite question']]), 'contact@exemple.fr')).toEqual([]);
  });

  it('ne compte pas Auto-Submitted: no comme une automatisation', () => {
    // RFC 3834 : `no` est la valeur d'un message écrit par un humain.
    expect(detectAutomationSignals(headersOf([['Auto-Submitted', 'no']]), 'contact@exemple.fr')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

describe('normalizeInboundMessage', () => {
  const base: GmailMessage = {
    id: 'gmail-42',
    threadId: 'th-42',
    internalDate: '1755036000000',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'Cleanyourcar <contact@exemple.fr>' },
        { name: 'To', value: 'operatoragency@example.com' },
        { name: 'Delivered-To', value: 'operatoragency@example.com' },
        { name: 'Subject', value: 'Re: Petite question' },
        { name: 'Message-ID', value: '<reply-1@mail.exemple.fr>' },
        { name: 'In-Reply-To', value: '<sortant-1@example.com>' },
        { name: 'References', value: '<sortant-1@example.com>' },
        { name: 'X-Interne-Non-Conservé', value: 'secret de routage' },
      ],
      body: { data: b64url('Oui, ça m’intéresse.') },
    },
  };

  it('produit une forme comparable et une empreinte du corps', () => {
    const normalized = normalizeInboundMessage(toInboundRawMessage(base));
    expect(normalized.fromAddress).toBe('contact@exemple.fr');
    expect(normalized.fromDisplay).toBe('Cleanyourcar');
    expect(normalized.normalizedSubject).toBe('petite question');
    expect(normalized.inReplyTo).toEqual(['<sortant-1@example.com>']);
    expect(normalized.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(normalized.receivedAt.toISOString()).toBe(new Date(1_755_036_000_000).toISOString());
  });

  it('ne conserve que le sous-ensemble d’en-têtes utile à la corrélation', () => {
    const normalized = normalizeInboundMessage(toInboundRawMessage(base));
    expect(Object.keys(normalized.rawHeaders)).toContain('in-reply-to');
    expect(Object.keys(normalized.rawHeaders)).not.toContain('x-interne-non-conservé');
  });

  it('refuse un message sans expéditeur lisible', () => {
    const raw = toInboundRawMessage({ ...base, payload: { ...base.payload, headers: [{ name: 'To', value: 'x@y.fr' }] } });
    expect(() => normalizeInboundMessage(raw)).toThrow(InboundNormalizationError);
  });

  it('refuse un message sans date de réception plutôt que d’en fabriquer une', () => {
    // « après l'envoi » est la condition que le repli faible vérifie : sans
    // date, elle serait évaluée sur une valeur inventée.
    const raw = toInboundRawMessage({ ...base, internalDate: undefined });
    expect(() => normalizeInboundMessage(raw)).toThrow(/internalDate/);
  });
});

// ---------------------------------------------------------------------------
// Corrélation
// ---------------------------------------------------------------------------

describe('correlateInbound', () => {
  const SENT_AT = new Date('2026-08-12T22:11:32.505Z');
  const RECEIVED_AT = new Date('2026-08-13T09:00:00.000Z');

  const send = (overrides: Partial<OutboundSend> = {}): OutboundSend =>
    Object.freeze({
      manifestId: 'manifest-1',
      outreachEventId: 'event-1',
      prospectId: 'prospect-1',
      recipient: 'cleanyourcar@exemple.fr',
      sentAt: SENT_AT,
      rfcMessageId: null,
      normalizedSubject: 'petite question pour cleanyourcar',
      ...overrides,
    });

  function inbound(overrides: Partial<Parameters<typeof correlateInbound>[0]> = {}) {
    const message = {
      providerMessageId: 'gmail-1',
      providerThreadId: 'th-1',
      providerHistoryId: null,
      receivedAt: RECEIVED_AT,
      fromAddress: 'cleanyourcar@exemple.fr',
      fromDisplay: null,
      toAddresses: ['operatoragency@example.com'] as readonly string[],
      ccAddresses: [] as readonly string[],
      replyToAddresses: [] as readonly string[],
      deliveredToAddresses: ['operatoragency@example.com'] as readonly string[],
      subject: 'Re: Petite question pour Cleanyourcar',
      normalizedSubject: 'petite question pour cleanyourcar',
      rfcMessageId: '<reply-1@exemple.fr>',
      inReplyTo: [] as readonly string[],
      referenceIds: [] as readonly string[],
      bodyText: 'oui',
      bodySha256: 'x'.repeat(64),
      bodySource: 'text/plain' as const,
      bodyTruncated: false,
      rawHeaders: {},
      automationSignals: [] as readonly string[],
      ...overrides,
    };
    return message;
  }

  const noTokens = new Map<string, ReplyTokenBinding>();

  it('EXACT quand In-Reply-To porte le Message-ID RFC d’un envoi connu', () => {
    const sends = [send({ rfcMessageId: '<out-1@example.com>' })];
    const result = correlateInbound(inbound({ inReplyTo: ['<out-1@example.com>'] }), sends, noTokens);
    expect(result.status).toBe('EXACT');
    expect(result.method).toBe('rfc_in_reply_to');
    expect(result.manifestId).toBe('manifest-1');
    expect(result.outreachEventId).toBe('event-1');
    expect(result.prospectId).toBe('prospect-1');
  });

  it('EXACT même quand le Message-ID n’apparaît que dans References', () => {
    const sends = [send({ rfcMessageId: '<out-1@example.com>' })];
    const result = correlateInbound(
      inbound({ referenceIds: ['<autre@x.fr>', '<out-1@example.com>'] }),
      sends,
      noTokens,
    );
    expect(result.status).toBe('EXACT');
  });

  it('EXACT quand un expéditeur INCONNU répond depuis une adresse déléguée', () => {
    // Le cas qui justifie la priorité de l'identifiant fort : le patron
    // transfère à son comptable, qui répond depuis SA boîte. Aucun repli
    // faible ne rattacherait ce message ; l'en-tête RFC, si.
    const sends = [send({ rfcMessageId: '<out-1@example.com>' })];
    const result = correlateInbound(
      inbound({ fromAddress: 'compta@cabinet.fr', inReplyTo: ['<out-1@example.com>'] }),
      sends,
      noTokens,
    );
    expect(result.status).toBe('EXACT');
    expect(result.manifestId).toBe('manifest-1');
  });

  it('EXACT quand un jeton d’adresse plus-taguée se résout en base', () => {
    const token = 'a1b2c3d4e5f6a7b8';
    const tokens = new Map<string, ReplyTokenBinding>([
      [token, { token, manifestId: 'manifest-1', revoked: false }],
    ]);
    const result = correlateInbound(
      inbound({
        fromAddress: 'inconnu@ailleurs.fr',
        deliveredToAddresses: [`operatoragency+${REPLY_TOKEN_PREFIX}${token}@example.com`],
      }),
      [send()],
      tokens,
    );
    expect(result.status).toBe('EXACT');
    expect(result.method).toBe('reply_token');
    expect(result.manifestId).toBe('manifest-1');
  });

  it('ne corrèle PAS un jeton inconnu, révoqué ou mal formé', () => {
    const unknown = 'ffffffffffffffff';
    const revoked = 'eeeeeeeeeeeeeeee';
    const tokens = new Map<string, ReplyTokenBinding>([
      [revoked, { token: revoked, manifestId: 'manifest-1', revoked: true }],
    ]);

    for (const address of [
      `operatoragency+${REPLY_TOKEN_PREFIX}${unknown}@example.com`,
      `operatoragency+${REPLY_TOKEN_PREFIX}${revoked}@example.com`,
      `operatoragency+${REPLY_TOKEN_PREFIX}trop-court@example.com`,
    ]) {
      const result = correlateInbound(
        inbound({ fromAddress: 'inconnu@ailleurs.fr', toAddresses: [address], deliveredToAddresses: [address] }),
        [send()],
        tokens,
      );
      expect(result.status, address).toBe('UNMATCHED');
      expect(result.manifestId, address).toBeNull();
      // Le refus est inscrit, pas tu : un jeton écarté est un fait.
      expect(result.evidence.rejectedTokens.length, address).toBeGreaterThan(0);
    }
  });

  it('refuse un jeton valide dont le manifeste n’a jamais été envoyé', () => {
    const token = 'b1b2c3d4e5f6a7b8';
    const tokens = new Map<string, ReplyTokenBinding>([
      [token, { token, manifestId: 'manifest-jamais-envoye', revoked: false }],
    ]);
    const result = correlateInbound(
      inbound({
        fromAddress: 'inconnu@ailleurs.fr',
        deliveredToAddresses: [`operatoragency+${REPLY_TOKEN_PREFIX}${token}@example.com`],
      }),
      [send()],
      tokens,
    );
    expect(result.status).toBe('UNMATCHED');
    expect(result.evidence.rejectedTokens).toContain(`${token}:no_send_for_manifest`);
  });

  it('REVIEW_REQUIRED quand deux identifiants forts se contredisent', () => {
    const token = 'c1b2c3d4e5f6a7b8';
    const sends = [
      send({ rfcMessageId: '<out-1@example.com>' }),
      send({ manifestId: 'manifest-2', outreachEventId: 'event-2', prospectId: 'prospect-2' }),
    ];
    const tokens = new Map<string, ReplyTokenBinding>([
      [token, { token, manifestId: 'manifest-2', revoked: false }],
    ]);
    const result = correlateInbound(
      inbound({
        inReplyTo: ['<out-1@example.com>'],
        deliveredToAddresses: [`operatoragency+${REPLY_TOKEN_PREFIX}${token}@example.com`],
      }),
      sends,
      tokens,
    );
    expect(result.status).toBe('REVIEW_REQUIRED');
    expect(result.method).toBe('conflicting_strong_identifiers');
    expect(result.manifestId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Repli du premier envoi réel
  // -------------------------------------------------------------------------

  it('HIGH_CONFIDENCE — et jamais EXACT — quand un seul envoi vise cet expéditeur', () => {
    const result = correlateInbound(inbound(), [send()], noTokens);
    expect(result.status).toBe('HIGH_CONFIDENCE');
    expect(result.method).toBe('sole_outbound_recipient');
    expect(result.manifestId).toBe('manifest-1');
    expect(result.evidence.subjectMatches).toBe(true);
  });

  it('accepte la présence d’en-têtes de réponse à défaut d’objet identique', () => {
    const result = correlateInbound(
      inbound({ subject: 'Rappel', normalizedSubject: 'rappel', inReplyTo: ['<inconnu@ailleurs.fr>'] }),
      [send()],
      noTokens,
    );
    expect(result.status).toBe('HIGH_CONFIDENCE');
    expect(result.evidence.subjectMatches).toBe(false);
  });

  it('REVIEW_REQUIRED — expéditeur connu mais aucune preuve que c’est une réponse', () => {
    const result = correlateInbound(
      inbound({ subject: 'Facture 2026', normalizedSubject: 'facture 2026' }),
      [send()],
      noTokens,
    );
    expect(result.status).toBe('REVIEW_REQUIRED');
    expect(result.method).toBe('recipient_without_reply_evidence');
    expect(result.manifestId).toBeNull();
  });

  it('REVIEW_REQUIRED dès qu’expéditeur + objet admettent plusieurs candidats', () => {
    // La règle qui fait mourir le repli faible toute seule, sans réglage à
    // changer : deux envois vers la même adresse et il cesse de conclure.
    const sends = [
      send(),
      send({
        manifestId: 'manifest-2',
        outreachEventId: 'event-2',
        prospectId: 'prospect-2',
        sentAt: new Date('2026-08-12T23:00:00.000Z'),
      }),
    ];
    const result = correlateInbound(inbound(), sends, noTokens);
    expect(result.status).toBe('REVIEW_REQUIRED');
    expect(result.method).toBe('ambiguous_outbound_candidates');
    expect(result.manifestId).toBeNull();
    expect(result.evidence.recipientCandidates).toEqual(['manifest-1', 'manifest-2']);
  });

  it('UNMATCHED sur un expéditeur inconnu', () => {
    const result = correlateInbound(inbound({ fromAddress: 'spam@ailleurs.fr' }), [send()], noTokens);
    expect(result.status).toBe('UNMATCHED');
    expect(result.method).toBeNull();
    expect(result.manifestId).toBeNull();
  });

  it('UNMATCHED sur un message ANTÉRIEUR à l’envoi', () => {
    // Sans cette borne, un vieil échange avec la même adresse deviendrait
    // « une réponse » à un email qui n'existait pas encore.
    const result = correlateInbound(
      inbound({ receivedAt: new Date('2026-08-01T00:00:00.000Z') }),
      [send()],
      noTokens,
    );
    expect(result.status).toBe('UNMATCHED');
    expect(result.evidence.priorSendCount).toBe(0);
  });

  it('UNMATCHED quand aucun envoi n’existe encore', () => {
    expect(correlateInbound(inbound(), [], noTokens).status).toBe('UNMATCHED');
  });
});

// ---------------------------------------------------------------------------
// Requête Gmail et portées
// ---------------------------------------------------------------------------

describe('buildInboxQuery', () => {
  const since = new Date('2026-08-11T22:00:00.000Z');

  it('borne la lecture aux contreparties sortantes et à une date — jamais à la boîte lue', () => {
    const q = buildInboxQuery(since, ['demo-prospect-b@yahoo.com']);
    expect(q).toContain('from:demo-prospect-b@yahoo.com');
    expect(q).toContain('after:2026/08/11');
    expect(q).toContain('-in:sent');
    expect(q).toContain('-in:draft');
    // R6B-D1.3 : le bug d'origine bornait sur la boîte lue elle-même
    // (`to:`/`deliveredto:` de la boîte de un opérateur), ce qui n'est aucune
    // borne — tout message livré y porte forcément ces en-têtes.
    expect(q).not.toContain('to:');
    expect(q).not.toContain('deliveredto:');
  });

  it('couvre plusieurs contreparties par un OU borné', () => {
    const q = buildInboxQuery(since, ['a@exemple.fr', 'b@exemple.fr']);
    expect(q).toMatch(/\{from:a@exemple\.fr from:b@exemple\.fr\}/);
  });

  it('n’utilise JAMAIS l’objet comme filtre', () => {
    // §13 : une réponse dont le client a réécrit l'objet disparaîtrait — et
    // c'est exactement la réponse qu'on attend.
    expect(buildInboxQuery(since, ['a@exemple.fr'])).not.toMatch(/subject:/i);
  });

  it('formate la date en UTC, indépendamment du fuseau du poste', () => {
    expect(gmailDate(new Date('2026-01-05T23:30:00.000Z'))).toBe('2026/01/05');
  });
});

describe('chunkCounterparties', () => {
  it('tient tout dans un seul chunk quand ça rentre', () => {
    const chunks = chunkCounterparties(['a@exemple.fr', 'b@exemple.fr', 'c@exemple.fr']);
    expect(chunks).toEqual([['a@exemple.fr', 'b@exemple.fr', 'c@exemple.fr']]);
  });

  it('coupe déterministement sans perdre ni dupliquer une adresse', () => {
    const addresses = Array.from({ length: 500 }, (_v, i) => `prospect-${i}@exemple-tres-tres-long.fr`);
    const chunks = chunkCounterparties(addresses, 200);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(addresses); // ordre préservé, rien omis, rien dupliqué
    for (const chunk of chunks) {
      const clauseLength = chunk.map((a) => `from:${a} `).join('').length;
      expect(clauseLength).toBeLessThanOrEqual(200);
    }
  });

  it('un même appel produit toujours le même découpage', () => {
    const addresses = Array.from({ length: 50 }, (_v, i) => `p${i}@exemple.fr`);
    expect(chunkCounterparties(addresses, 100)).toEqual(chunkCounterparties(addresses, 100));
  });

  it('une seule adresse trop longue pour la borne forme quand même son propre chunk', () => {
    const chunks = chunkCounterparties(['une-adresse-plus-longue-que-la-borne@exemple.fr'], 5);
    expect(chunks).toEqual([['une-adresse-plus-longue-que-la-borne@exemple.fr']]);
  });

  it('la borne par défaut est raisonnablement conservatrice', () => {
    expect(MAX_QUERY_CLAUSE_LENGTH).toBeGreaterThan(0);
    expect(MAX_QUERY_CLAUSE_LENGTH).toBeLessThan(4000);
  });
});

describe('assertReadOnlyScope', () => {
  it('accepte la portée lecture seule', () => {
    expect(() => assertReadOnlyScope(GMAIL_READONLY_SCOPE)).not.toThrow();
  });

  it('REFUSE un jeton portant une portée d’écriture', () => {
    // Refuser rend l'écriture impossible ; se contenter de ne pas appeler
    // d'endpoint d'écriture la rendrait seulement improbable.
    for (const scope of [
      'https://mail.google.com/',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send',
    ]) {
      expect(() => assertReadOnlyScope(`${GMAIL_READONLY_SCOPE} ${scope}`)).toThrow(GmailScopeError);
    }
  });

  it('refuse un jeton sans aucune portée de lecture', () => {
    expect(() => assertReadOnlyScope('')).toThrow(/portée de lecture/);
    expect(() => assertReadOnlyScope('https://www.googleapis.com/auth/drive.readonly')).toThrow(GmailScopeError);
  });
});
