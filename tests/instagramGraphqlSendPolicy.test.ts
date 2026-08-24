import { describe, expect, it } from 'vitest';
import {
  LIVE_DM_ALLOWED_GRAPHQL_OPERATIONS,
  LIVE_DM_GRAPHQL_PATH,
  classifyAdjudicationRequest,
  classifyInstagramRequest,
  classifyLiveDmRequest,
  readFriendlyName,
  type GuardDecision,
} from '@/lib/instagram/readOnlyGuard';

/**
 * IG2.7 — l'autorisation nominative de l'opération d'envoi observée.
 *
 * Cause racine, établie par mesure et non par supposition : le 14 août, 45 ms
 * après le clic, notre propre garde refusait `POST /api/graphql` portant
 * `IGDirectTextSendMutation` sous la règle `graphql_effect`. La requête d'envoi
 * ne sortait pas du processus.
 *
 * Ce fichier existe pour empêcher la correction de dériver. Une autorisation
 * accordée à UNE opération nommée doit rester une autorisation accordée à UNE
 * opération nommée : ces tests décrivent surtout ce qui doit continuer d'être
 * refusé, y compris des noms qui ressemblent beaucoup au bon.
 */

const GRAPHQL_URL = `https://www.instagram.com${LIVE_DM_GRAPHQL_PATH}`;

/** Un corps de requête réaliste : formulaire encodé, nom d'opération, doc_id. */
function graphqlBody(friendlyName: string): string {
  return `av=17841400000000000&fb_api_req_friendly_name=${friendlyName}&doc_id=9876543210&variables=%7B%7D`;
}

function live(friendlyName: string, url = GRAPHQL_URL): GuardDecision {
  return classifyLiveDmRequest({ url, method: 'POST', postData: graphqlBody(friendlyName) });
}

// ---------------------------------------------------------------------------
// La matrice des trois opérations réellement observées
// ---------------------------------------------------------------------------

describe('IG2.7 — les trois opérations observées le 14 août', () => {
  it('IGDirectTextSendMutation → ALLOW, sous une règle qui la nomme', () => {
    const decision = live('IGDirectTextSendMutation');
    expect(decision.allowed).toBe(true);
    expect(decision.rule).toBe('graphql_direct_send');
  });

  it('useIGDMarkThreadAsReadMutation → DENY', () => {
    const decision = live('useIGDMarkThreadAsReadMutation');
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe('graphql_effect');
  });

  it('useIGDMarkThreadAsReadValidationMutation → DENY', () => {
    const decision = live('useIGDMarkThreadAsReadValidationMutation');
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe('graphql_effect');
  });

  /**
   * Le point de la mission : remettre un message et écrire l'état « lu » sont
   * deux capacités, pas une. Les accorder ensemble parce qu'elles sont arrivées
   * dans la même seconde serait un raccourci, pas un raisonnement.
   */
  it('sépare la capacité de REMETTRE de la mutation d’état « thread read »', () => {
    expect(live('IGDirectTextSendMutation').allowed).toBe(true);
    expect(live('useIGDMarkThreadAsReadMutation').allowed).toBe(false);
    expect(live('useIGDMarkThreadAsReadValidationMutation').allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// L'égalité est une égalité : les quasi-homonymes restent refusés
// ---------------------------------------------------------------------------

describe('IG2.7 — aucun wildcard autour du nom autorisé', () => {
  const lookalikes = [
    'IGDirectPhotoSendMutation',
    'IGDirectSomethingSendMutation',
    'NotIGDirectTextSendMutation',
    'IGDirectTextSendMutationFoo',
    'IGDirectTextSendMutation2',
    'IGDirectTextSend',
    'XIGDirectTextSendMutation',
    'IGDirectTextSendMutation_v2',
    'IGDirectThreadSendMutation',
    'IGDirectMessageSendMutation',
  ] as const;

  it('aucun quasi-homonyme n’obtient l’autorisation nominative', () => {
    for (const name of lookalikes) {
      expect(live(name).rule, `${name} ne doit pas passer par la règle nominative`).not.toBe('graphql_direct_send');
    }
  });

  it('et ceux qui sont des mutations sont refusés, comme avant IG2.7', () => {
    // `IGDirectTextSend` est écarté de cette liste à dessein : son corps ne
    // contient pas « mutation », donc la politique PRÉEXISTANTE le traite comme
    // une lecture et le laisse passer — ce n'est pas un effet d'IG2.7, et le
    // corriger serait un changement de politique que la mission exclut.
    for (const name of lookalikes.filter((candidate) => /mutation/i.test(candidate))) {
      const decision = live(name);
      expect(decision.allowed, `attendu REFUSÉ : ${name}`).toBe(false);
      expect(decision.rule).toBe('graphql_effect');
    }
  });

  it('la comparaison est sensible à la casse', () => {
    for (const name of [
      'igdirecttextsendmutation',
      'IGDIRECTTEXTSENDMUTATION',
      'IgDirectTextSendMutation',
      'IGDirectTextSendmutation',
    ]) {
      expect(live(name).allowed, `attendu REFUSÉ : ${name}`).toBe(false);
    }
  });

  /**
   * Le changement que la mission a écarté — retirer la frontière de mot de
   * `\bdirect[A-Za-z]*(send|thread|message)` — aurait laissé passer ces trois
   * noms-là. Ce test est la démonstration chiffrée de « plus étroit ».
   */
  it('reste plus étroit que la regex élargie qui aurait aussi marché', () => {
    const widened = /direct[A-Za-z]*(send|thread|message)/i;
    for (const name of ['IGDirectPhotoSendMutation', 'IGDirectThreadSendMutation', 'IGDirectMessageSendMutation']) {
      expect(widened.test(name), `${name} aurait passé la regex élargie`).toBe(true);
      expect(live(name).allowed, `${name} doit rester refusé par l’égalité`).toBe(false);
    }
  });

  it('n’autorise qu’une seule opération, et le dit dans son type', () => {
    expect(LIVE_DM_ALLOWED_GRAPHQL_OPERATIONS).toEqual(['IGDirectTextSendMutation']);
    expect(LIVE_DM_ALLOWED_GRAPHQL_OPERATIONS).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Corps absent, malformé, ou sans nom d'opération
// ---------------------------------------------------------------------------

describe('IG2.7 — l’autorisation exige un nom lisible', () => {
  it('refuse une mutation sans fb_api_req_friendly_name', () => {
    const decision = classifyLiveDmRequest({
      url: GRAPHQL_URL,
      method: 'POST',
      postData: 'doc_id=9876543210&variables=%7B%7D&query=mutation+Send+%7B+ok+%7D',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe('graphql_effect');
  });

  it('refuse un friendlyName malformé ou vide', () => {
    for (const body of [
      'fb_api_req_friendly_name=&doc_id=1&mutation',
      'fb_api_req_friendly_name&mutation',
      'fb_api_req_friendly_name=%%%&mutation',
      'fb_api_req_friendly_name= IGDirectTextSendMutation&mutation',
    ]) {
      const decision = classifyLiveDmRequest({ url: GRAPHQL_URL, method: 'POST', postData: body });
      expect(decision.allowed, `attendu REFUSÉ pour : ${body}`).toBe(false);
    }
  });

  it('refuse un corps illisible — `null` n’est pas « vide »', () => {
    // Sans corps, il n'y a pas de nom d'opération, donc pas d'autorisation
    // nominative possible. La règle générale reprend la main.
    const decision = classifyLiveDmRequest({ url: GRAPHQL_URL, method: 'POST', postData: null });
    expect(decision.rule).not.toBe('graphql_direct_send');
  });

  it('un corps sans « mutation » reste une lecture, comme avant', () => {
    const decision = classifyLiveDmRequest({
      url: GRAPHQL_URL,
      method: 'POST',
      postData: 'fb_api_req_friendly_name=PolarisProfilePageContentQuery&doc_id=1',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.rule).toBe('read_only_endpoint');
  });

  it('le parseur ne ramène jamais le payload, seulement le nom', () => {
    const body =
      'fb_api_req_friendly_name=IGDirectTextSendMutation&csrf_token=SECRET&variables=%7B%22text%22%3A%22bonjour%22%7D';
    expect(readFriendlyName(body)).toBe('IGDirectTextSendMutation');
    expect(readFriendlyName(null)).toBeNull();
    expect(readFriendlyName('rien du tout')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// L'autorisation est liée au chemin, et au seul rail LIVE DM
// ---------------------------------------------------------------------------

describe('IG2.7 — périmètre de l’autorisation', () => {
  it('ne vaut que sur /api/graphql', () => {
    const other = live('IGDirectTextSendMutation', 'https://www.instagram.com/graphql/query');
    expect(other.rule).not.toBe('graphql_direct_send');
    expect(other.allowed).toBe(false);

    const telemetry = live('IGDirectTextSendMutation', 'https://www.instagram.com/ajax/bz');
    expect(telemetry.allowed).toBe(false);
    expect(telemetry.rule).toBe('write_method');
  });

  it('ne vaut pas en GET — un GET était déjà permis, et pour une autre raison', () => {
    const decision = classifyLiveDmRequest({
      url: GRAPHQL_URL,
      method: 'GET',
      postData: graphqlBody('IGDirectTextSendMutation'),
    });
    expect(decision.rule).toBe('read_method');
  });

  it('ne déteint pas sur la garde de LECTURE SEULE', () => {
    const decision = classifyInstagramRequest({
      url: GRAPHQL_URL,
      method: 'POST',
      postData: graphqlBody('IGDirectTextSendMutation'),
    });
    expect(decision.allowed).toBe(false);
  });

  it('ne déteint pas sur la garde d’ADJUDICATION — relire ne doit jamais rejouer', () => {
    // C'est la propriété qui rend l'ouverture d'un fil sûre après un échec :
    // même l'application Instagram, rejouant d'elle-même un message resté en
    // erreur, doit être refusée.
    const decision = classifyAdjudicationRequest({
      url: GRAPHQL_URL,
      method: 'POST',
      postData: graphqlBody('IGDirectTextSendMutation'),
    });
    expect(decision.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rien d'autre n'a bougé
// ---------------------------------------------------------------------------

describe('IG2.7 — aucun autre assouplissement', () => {
  it('les effets sociaux restent refusés, avec ou sans nom d’opération autorisé', () => {
    for (const url of [
      'https://www.instagram.com/web/friendships/42/follow/',
      'https://www.instagram.com/web/likes/42/like/',
      'https://www.instagram.com/web/comments/42/add/',
      'https://www.instagram.com/api/v1/users/report',
    ]) {
      expect(classifyLiveDmRequest({ url, method: 'POST', postData: graphqlBody('IGDirectTextSendMutation') }).allowed)
        .toBe(false);
    }
  });

  it('la politique POST générale est intacte : hors liste, refus par défaut', () => {
    for (const path of ['/ajax/bz', '/ajax/qm/', '/logging_client_events', '/sync/instagram/']) {
      const decision = classifyLiveDmRequest({
        url: `https://www.instagram.com${path}`,
        method: 'POST',
        postData: null,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.rule).toBe('write_method');
    }
  });

  it('les chemins de messagerie restent permis, comme avant IG2.7', () => {
    expect(
      classifyLiveDmRequest({
        url: 'https://www.instagram.com/api/v1/direct_v2/threads/broadcast/text/',
        method: 'POST',
        postData: 'text=x',
      }).allowed,
    ).toBe(true);
  });

  it('les marqueurs de messagerie existants fonctionnent toujours', () => {
    const decision = classifyLiveDmRequest({
      url: GRAPHQL_URL,
      method: 'POST',
      postData: 'mutation direct_v2 { send }',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.rule).toBe('read_only_endpoint');
  });

  it('une mutation GraphQL quelconque reste refusée', () => {
    for (const name of ['useIGFollowMutation', 'PolarisLikeMediaMutation', 'IGBlockUserMutation']) {
      expect(live(name).allowed, `attendu REFUSÉ : ${name}`).toBe(false);
    }
  });
});
