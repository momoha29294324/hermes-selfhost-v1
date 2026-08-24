import type { ModelRoute } from '@/lib/config/schema';

export interface LlmRequest {
  /** Routing key, e.g. "classification" — matched against config/models.json. */
  task: string;
  system?: string;
  prompt: string;
  /** JSON Schema the answer must satisfy. Providers enforce it natively when they can. */
  schema?: Record<string, unknown>;
  /** Free-form reference stored on the model_runs row, e.g. "prospect:<uuid>". */
  inputRef?: string;
}

/**
 * What a provider actually reported about one call.
 *
 * Every field is nullable and stays null when the provider did not publish it.
 * R5.1 needs this to be an observation rather than an estimate: a benchmark
 * that infers its own token counts measures its inference, not the models.
 */
export interface LlmUsage {
  tokensInput: number | null;
  /** Prompt tokens served from the provider's cache — billed differently. */
  tokensCachedInput: number | null;
  tokensCacheWrite: number | null;
  tokensOutput: number | null;
  /** Reasoning tokens, when the provider separates them from the answer. */
  tokensReasoning: number | null;
}

export const EMPTY_USAGE: LlmUsage = {
  tokensInput: null,
  tokensCachedInput: null,
  tokensCacheWrite: null,
  tokensOutput: null,
  tokensReasoning: null,
};

export interface LlmGeneration {
  text: string;
  usage?: LlmUsage;
}

export interface LlmProvider {
  readonly name: string;
  /** Reports why the provider cannot run, without throwing. */
  availability(): { ok: boolean; reason?: string };
  generate(request: LlmRequest, route: ModelRoute): Promise<LlmGeneration>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: 'unavailable' | 'timeout' | 'invalid_output' | 'provider_error',
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
