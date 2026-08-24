import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { instagramRailSchema } from '@/lib/config/schema';
import {
  canonicalAccountIdentity,
  isKnownAccountIdentity,
  knownAccountHandles,
} from '@/lib/instagram/accountIdentity';
import { classifyAccountIdentity } from '@/lib/instagram/threadInspectionRail';

/**
 * HERMES-IDENTITY-CANONICALIZATION-R1 §22 — l'identité de NOTRE compte, et la
 * frontière entre « comment il s'appelle » et « comment il s'appelait ».
 *
 * Le round qui a produit ces tests corrigeait un refus permanent : la session
 * est ouverte sous `hermes__`, les huit messages déjà relevés portent
 * `hermesagency_` dans `mailbox`, et `sendThreadReply` confrontait le second à
 * la page. Ce qui est éprouvé ici est la séparation elle-même — pas une valeur.
 */

const ROOT = resolve(__dirname, '..');

function identity(current: string, former: readonly string[] = []) {
  const resolved = canonicalAccountIdentity({ accountHandle: current, formerAccountHandles: [...former] });
  if (!resolved.ok) throw new Error(`${resolved.refusal} — ${resolved.detail}`);
  return resolved.identity;
}

describe('§4/§7 — l’identité canonique se construit, ou refuse', () => {
  it('normalise la casse et le @, sans rien inventer d’autre', () => {
    const built = identity('@Hermes__', ['HermesAgency_']);
    expect(built.currentHandle).toBe('hermes__');
    expect(built.formerHandles).toEqual(['hermesagency_']);
  });

  it('un compte sans passé n’a rien à déclarer', () => {
    const built = identity('hermes__');
    expect(built.formerHandles).toEqual([]);
    expect(knownAccountHandles(built)).toEqual(['hermes__']);
  });

  it('un handle courant illisible refuse — aucune session ne peut être confrontée à rien', () => {
    const resolved = canonicalAccountIdentity({ accountHandle: '', formerAccountHandles: [] });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.refusal).toBe('ACCOUNT_HANDLE_UNREADABLE');
  });

  it('un ancien handle illisible refuse plutôt que d’être ignoré en silence', () => {
    const resolved = canonicalAccountIdentity({
      accountHandle: 'hermes__',
      formerAccountHandles: ['pas un handle'],
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.refusal).toBe('ACCOUNT_FORMER_HANDLE_UNREADABLE');
  });

  it('le courant déclaré aussi comme ancien décrit deux choses avec un mot — refusé', () => {
    const resolved = canonicalAccountIdentity({
      accountHandle: 'hermes__',
      formerAccountHandles: ['HERMES__'],
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.refusal).toBe('ACCOUNT_FORMER_HANDLE_IS_CURRENT');
  });

  it('un ancien handle répété refuse : une liste qui bégaie ne dit pas ce qu’elle veut dire', () => {
    const resolved = canonicalAccountIdentity({
      accountHandle: 'hermes__',
      formerAccountHandles: ['hermesagency_', 'HermesAgency_'],
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.refusal).toBe('ACCOUNT_FORMER_HANDLE_DUPLICATED');
  });
});

describe('§6 — « était-ce nous ? » n’est pas « est-ce le nom d’aujourd’hui ? »', () => {
  const built = identity('hermes__', ['hermesagency_']);

  it('le handle COURANT est une identité connue', () => {
    expect(isKnownAccountIdentity(built, 'hermes__')).toBe(true);
    expect(isKnownAccountIdentity(built, '@Hermes__')).toBe(true);
  });

  it('un handle HISTORIQUE reste une identité connue — l’histoire n’est pas réécrite', () => {
    expect(isKnownAccountIdentity(built, 'hermesagency_')).toBe(true);
  });

  it('une boîte étrangère n’est jamais la nôtre', () => {
    expect(isKnownAccountIdentity(built, 'quelqu_un_dautre')).toBe(false);
  });

  it('une valeur illisible n’est pas une identité — « je n’ai pas su lire » n’est pas « c’était nous »', () => {
    expect(isKnownAccountIdentity(built, '')).toBe(false);
    expect(isKnownAccountIdentity(built, 'un handle avec des espaces')).toBe(false);
  });

  it('sans passé déclaré, l’ancien handle cesse d’être reconnu — la liste DÉCIDE', () => {
    expect(isKnownAccountIdentity(identity('hermes__'), 'hermesagency_')).toBe(false);
  });
});

describe('§5 — ce que le fichier canonique livre', () => {
  const raw = (): Record<string, unknown> =>
    JSON.parse(readFileSync(resolve(ROOT, 'config/instagram.json'), 'utf8')) as Record<string, unknown>;
  const parsed = instagramRailSchema.parse(raw());

  it('la configuration livrée ne nomme AUCUN compte', () => {
    // Un compte écrit ici serait celui de quelqu'un d'autre. Le défaut livré
    // est donc un marqueur qui ne peut appartenir à personne : la relève
    // refusera tant qu'un opérateur n'aura pas écrit le SIEN.
    expect(parsed.inbound.accountHandle).toBe('UNCONFIGURED');
  });

  it('aucun ancien nom n’est déclaré non plus', () => {
    expect(parsed.inbound.formerAccountHandles).toEqual([]);
  });

  it('la configuration livrée ne reconnaît AUCUN compte réel', () => {
    // Le marqueur se construit sans lever — le schéma est satisfait — mais il
    // ne reconnaît personne. Une boîte relevée sous n'importe quel vrai nom
    // rendra donc « ce compte n'est pas le nôtre », ce qui est le bon refus
    // tant que l'opérateur n'a pas déclaré le sien.
    const built = identity(parsed.inbound.accountHandle ?? '', parsed.inbound.formerAccountHandles);
    expect(built.currentHandle).toBe('unconfigured');
    expect(isKnownAccountIdentity(built, 'un_compte_reel')).toBe(false);
  });

  it('un ancien handle égal au courant est refusé PAR LE SCHÉMA, sur le fichier', () => {
    expect(() =>
      instagramRailSchema.parse({
        ...raw(),
        inbound: { accountHandle: 'hermes__', formerAccountHandles: ['hermes__'] },
      }),
    ).toThrow();
  });

  it('un ancien handle répété est refusé PAR LE SCHÉMA', () => {
    expect(() =>
      instagramRailSchema.parse({
        ...raw(),
        inbound: { accountHandle: 'hermes__', formerAccountHandles: ['a_', 'A_'] },
      }),
    ).toThrow();
  });

  it('le défaut du schéma reste « aucun passé déclaré »', () => {
    expect(instagramRailSchema.parse({ ...raw(), inbound: {} }).inbound.formerAccountHandles).toEqual([]);
  });
});

describe('§22 — ce que la PAGE affirme, et ce qu’elle laisse indécis', () => {
  it('« Modifier le profil » lu sur la page du compte courant ⇒ MATCH', () => {
    expect(classifyAccountIdentity(true)).toBe('MATCH');
  });

  it('des actions de relation ⇒ MISMATCH : la page affirme que ce n’est pas nous', () => {
    expect(classifyAccountIdentity(false)).toBe('MISMATCH');
  });

  it('un en-tête muet ⇒ UNKNOWN, jamais un verdict d’identité', () => {
    expect(classifyAccountIdentity(null)).toBe('UNKNOWN');
  });

  it('un profil ABSENT rend MISMATCH — un refus définitif, pas une session perdue rejouée sans fin', () => {
    // La correction du 22 août 2026 : `stageAccountIdentity` interroge
    // `isProfileMissing` AVANT de lire l'en-tête, et rend `MISMATCH`. Ce qui
    // est vérifié ici est que le chemin existe encore et qu'il précède la
    // lecture d'en-tête — sans lui, `isOwnProfile === null` ⇒ `UNKNOWN` ⇒
    // `IG_REPLY_SESSION_LOST`, temporaire, donc rejoué toutes les cinq minutes.
    const source = readFileSync(resolve(ROOT, 'src/lib/instagram/playwrightThreadInspectionRail.ts'), 'utf8');
    const stage = source.slice(source.indexOf('protected async stageAccountIdentity'));
    const missingAt = stage.indexOf('isProfileMissing(page)');
    const relationshipAt = stage.indexOf('readRelationship(page)');
    expect(missingAt).toBeGreaterThan(-1);
    expect(relationshipAt).toBeGreaterThan(missingAt);
    expect(stage.slice(missingAt, relationshipAt)).toContain("outcome: 'MISMATCH' as const");
  });
});
