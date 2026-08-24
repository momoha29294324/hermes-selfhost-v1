/**
 * QUI écrit, à QUI, et avec quelle voix.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi ce fichier existe
 * ---------------------------------------------------------------------------
 * Un moteur de prospection ne peut pas deviner l'entreprise qu'il représente.
 * Tant que personne ne le lui a dit, il n'a rien à écrire à un inconnu — et
 * c'est exactement l'état d'une instance fraîchement installée.
 *
 * Ce module rend cet état LISIBLE et OPPOSABLE. `UNCONFIGURED` n'est pas une
 * valeur par défaut prudente qu'on pourrait oublier de remplacer : c'est un
 * statut que le générateur de premier message relit, et sur lequel il REFUSE.
 * Installer Hermes, connecter un compte et importer des prospects ne suffit
 * donc jamais à produire un message froid.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce fichier NE contient pas
 * ---------------------------------------------------------------------------
 * Aucune valeur d'exemple n'est câblée ici. Ni nom d'entreprise, ni secteur, ni
 * exemple de message : ces choses appartiennent à l'opérateur, elles vivent
 * dans `config/operator.json`, et ce fichier n'est pas livré rempli.
 */
import { z } from 'zod';

/** Le statut d'une instance vis-à-vis de sa propre identité commerciale. */
export type OperatorProfileStatus = 'CONFIGURED' | 'UNCONFIGURED';

/**
 * Un exemple de voix fourni par l'opérateur : un message qu'il a lui-même
 * écrit ou approuvé, et dont il veut que le ton soit repris.
 *
 * Cette édition n'en embarque AUCUN. Un exemple de message est le fruit d'une
 * calibration — il porte le marché, le registre et les tournures de celui qui
 * l'a écrit — et il ne se transporte pas d'une instance à une autre.
 */
export const voiceExampleSchema = z.object({
  body: z.string().min(20),
  note: z.string().default(''),
});

export type VoiceExample = z.infer<typeof voiceExampleSchema>;

export const operatorProfileSchema = z.object({
  /** Le nom porté par les gestes nominatifs (`--as`). */
  operatorName: z.string().min(2),
  /** Ce que l'expéditeur EST, en une proposition. Sert de sujet au prompt. */
  senderDescription: z.string().min(10),
  /** À QUI l'on écrit, en une proposition. */
  audienceDescription: z.string().min(10),
  /** La verticale déclarée. Relue par la politique de verticale. */
  vertical: z.string().min(2),
  /** Optionnels, et vides par défaut. */
  voiceExamples: z.array(voiceExampleSchema).default([]),
});

export type OperatorProfileConfig = z.infer<typeof operatorProfileSchema>;

export interface OperatorProfile {
  readonly status: OperatorProfileStatus;
  readonly operatorName: string | null;
  readonly senderDescription: string | null;
  readonly audienceDescription: string | null;
  readonly vertical: string | null;
  readonly voiceExamples: readonly VoiceExample[];
}

/** L'état d'une instance qui n'a pas encore été configurée. */
export const UNCONFIGURED_OPERATOR_PROFILE: OperatorProfile = Object.freeze({
  status: 'UNCONFIGURED',
  operatorName: null,
  senderDescription: null,
  audienceDescription: null,
  vertical: null,
  voiceExamples: Object.freeze([]),
});

/** Levée quand un chemin qui parle à un inconnu est atteint sans identité. */
export class OperatorProfileUnconfiguredError extends Error {
  constructor(what: string) {
    super(
      `${what} est impossible tant que l'identité de l'opérateur n'est pas configurée. ` +
        `Renseigner config/operator.json (voir config/operator.example.json).`,
    );
    this.name = 'OperatorProfileUnconfiguredError';
  }
}

export function isConfigured(profile: OperatorProfile): boolean {
  return profile.status === 'CONFIGURED';
}

/** Rend le profil, ou LÈVE. Aucun appelant ne peut ignorer l'absence par omission. */
export function requireOperatorProfile(profile: OperatorProfile, what: string): Required<{
  operatorName: string;
  senderDescription: string;
  audienceDescription: string;
  vertical: string;
  voiceExamples: readonly VoiceExample[];
}> {
  if (
    profile.status !== 'CONFIGURED' ||
    profile.senderDescription === null ||
    profile.audienceDescription === null ||
    profile.vertical === null ||
    profile.operatorName === null
  ) {
    throw new OperatorProfileUnconfiguredError(what);
  }
  return {
    operatorName: profile.operatorName,
    senderDescription: profile.senderDescription,
    audienceDescription: profile.audienceDescription,
    vertical: profile.vertical,
    voiceExamples: profile.voiceExamples,
  };
}
