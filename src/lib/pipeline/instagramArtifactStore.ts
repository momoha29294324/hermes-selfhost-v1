import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { profileObservationSchema, type ProfileObservation } from '@/lib/pipeline/instagramObservation';
import { rubricObservationSchema, type RubricObservation } from '@/lib/pipeline/visualMaturityRubric';

/**
 * R7.3C §32, §35, §36 — où vivent les observations, et pourquoi pas en base.
 *
 * ---------------------------------------------------------------------------
 * Un artefact local, pas une migration
 * ---------------------------------------------------------------------------
 * La mission le demande, et la raison tient : ces observations n'ont pas encore
 * de statut. Les écrire dans `prospect_evidence` les rendrait consultables par
 * le CRM, projetables vers un sous-compte, et un jour confondues avec un fait
 * établi sur un prospect. Elles restent donc sous `var/` — hors Git, hors
 * Supabase — et n'atteignent le moteur que par une commande qui ne fait que lire.
 *
 * Le §33 est explicite : une table dédiée est un travail de CONCEPTION, pas
 * d'application. Une proposition de migration existe, aucune
 * migration n'est écrite dans `db/migrations/`.
 *
 * ---------------------------------------------------------------------------
 * Séparer COLLECTE et SCORING (§36)
 * ---------------------------------------------------------------------------
 * `observations.jsonl` est la frontière. Tout ce qui vient après — maturité
 * sociale, Model B, classements, rapports — se recalcule depuis ce fichier sans
 * rouvrir un seul profil Instagram. C'est ce qui rend une calibration
 * répétable : quarante configurations balayées, zéro visite supplémentaire.
 *
 * Une ligne par TENTATIVE, succès comme échec, en ajout seul. Un fichier qui ne
 * porterait que les réussites laisserait croire que les autres n'ont jamais été
 * tentées, et c'est précisément le genre de silence qui fait surestimer une
 * couverture.
 */

export const OBSERVATIONS_FILE = 'observations.jsonl';
export const VISUAL_REVIEWS_FILE = 'visual-reviews.jsonl';
export const RUN_MANIFEST_FILE = 'run-manifest.json';

/** §35 — ce qu'une exécution doit rendre d'elle-même. Aucun secret, aucun cookie. */
export const runManifestSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  startedAt: z.string().min(1),
  completedAt: z.string().min(1).nullable(),
  phase: z.string().min(1),
  browserMode: z.enum(['headless', 'headed']),
  authMode: z.enum(['anonymous', 'dedicated_session']),
  /** Les deux chemins RÉSOLUS, publiés pour que l'isolation se relise. */
  observerProfileDir: z.string().min(1),
  outboundProfileDir: z.string().min(1),
  profilesIsolated: z.boolean(),
  prospectsTargeted: z.number().int().min(0),
  observed: z.number().int().min(0),
  partial: z.number().int().min(0),
  privateAccounts: z.number().int().min(0),
  notFound: z.number().int().min(0),
  identityContradiction: z.number().int().min(0),
  failed: z.number().int().min(0),
  blocked: z.number().int().min(0),
  /** §46 — le compteur qui rend la garantie vérifiable plutôt qu'affirmée. */
  networkWritesBlocked: z.number().int().min(0),
  networkWritesSucceeded: z.literal(0),
  /** Lectures transportées en POST, autorisées. Ce ne sont pas des écritures. */
  graphqlReadsAllowed: z.number().int().min(0),
  blockedByRule: z.record(z.string(), z.number().int().min(0)),
  screenshotsCreated: z.number().int().min(0),
  /** R7.3D — couverture temporelle réellement obtenue, publiée avec le run. */
  postsDated: z.number().int().min(0).default(0),
  lastPostAtKnown: z.number().int().min(0).default(0),
  cadenceKnown: z.number().int().min(0).default(0),
  /** Publications écartées parce qu'elles appartiennent à un autre compte. */
  postsRejectedForeignOwner: z.number().int().min(0).default(0),
  stoppedEarly: z.boolean(),
  stopReason: z.string().nullable(),
});

export type RunManifest = z.infer<typeof runManifestSchema>;

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export class InstagramArtifactStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(process.cwd(), root);
  }

  get rootPath(): string {
    return this.root;
  }

  get observationsPath(): string {
    return resolve(this.root, OBSERVATIONS_FILE);
  }

  get visualReviewsPath(): string {
    return resolve(this.root, VISUAL_REVIEWS_FILE);
  }

  get manifestPath(): string {
    return resolve(this.root, RUN_MANIFEST_FILE);
  }

  /**
   * Ajoute une observation, et écrit la fiche par prospect.
   *
   * Deux écritures pour deux usages : le `.jsonl` est l'HISTORIQUE (append seul,
   * jamais réécrit, donc jamais perdu), la fiche est l'ÉTAT COURANT (écrasée,
   * donc facile à lire à l'œil). L'historique fait foi ; la fiche est un confort.
   */
  appendObservation(observation: ProfileObservation): void {
    ensureDir(this.root);
    appendFileSync(this.observationsPath, `${JSON.stringify(observation)}\n`, 'utf8');

    const profilePath = resolve(this.root, 'profiles', `${observation.prospectId}.json`);
    ensureDir(dirname(profilePath));
    this.writeAtomic(profilePath, `${JSON.stringify(observation, null, 2)}\n`);
  }

  /**
   * Toutes les observations, la plus RÉCENTE l'emportant par prospect.
   *
   * Une ligne illisible est ignorée avec son numéro plutôt que de faire échouer
   * la lecture entière : un fichier d'ajout peut se terminer par une ligne
   * tronquée si un processus a été tué, et perdre trente observations valides
   * pour une ligne coupée serait un mauvais échange.
   */
  readObservations(): { readonly observations: ProfileObservation[]; readonly skipped: number } {
    if (!existsSync(this.observationsPath)) return { observations: [], skipped: 0 };
    const lines = readFileSync(this.observationsPath, 'utf8').split('\n');
    const byProspect = new Map<string, ProfileObservation>();
    let skipped = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: ProfileObservation;
      try {
        parsed = profileObservationSchema.parse(JSON.parse(trimmed));
      } catch {
        skipped += 1;
        continue;
      }
      const existing = byProspect.get(parsed.prospectId);
      if (existing === undefined || parsed.observedAt >= existing.observedAt) {
        byProspect.set(parsed.prospectId, parsed);
      }
    }
    return {
      observations: [...byProspect.values()].sort((a, b) => a.prospectId.localeCompare(b.prospectId)),
      skipped,
    };
  }

  /**
   * §21 — une revue visuelle, attachée à l'EMPREINTE de l'image regardée.
   *
   * La clé est le sha256 de la capture, jamais le prospect : une revue ne peut
   * donc pas être recyclée d'une capture à l'autre, et une nouvelle capture
   * exige une nouvelle revue. C'est ce qui empêche un jugement de survivre au
   * profil qui l'a produit.
   */
  appendVisualReview(review: RubricObservation): void {
    ensureDir(this.root);
    appendFileSync(this.visualReviewsPath, `${JSON.stringify(review)}\n`, 'utf8');
  }

  readVisualReviews(): Map<string, RubricObservation> {
    if (!existsSync(this.visualReviewsPath)) return new Map();
    const reviews = new Map<string, RubricObservation>();
    for (const line of readFileSync(this.visualReviewsPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = rubricObservationSchema.parse(JSON.parse(trimmed));
        reviews.set(parsed.screenshotSha256, parsed);
      } catch {
        // Une revue illisible n'est pas une revue. Elle disparaît en silence
        // plutôt que d'empêcher les autres d'être lues.
      }
    }
    return reviews;
  }

  writeManifest(manifest: RunManifest): void {
    ensureDir(this.root);
    this.writeAtomic(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  readManifest(): RunManifest | null {
    if (!existsSync(this.manifestPath)) return null;
    try {
      return runManifestSchema.parse(JSON.parse(readFileSync(this.manifestPath, 'utf8')));
    } catch {
      return null;
    }
  }

  /** Écrire à côté puis renommer : le fichier lu est toujours un fichier complet. */
  private writeAtomic(path: string, content: string): void {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, content, 'utf8');
    renameSync(temporary, path);
  }
}
