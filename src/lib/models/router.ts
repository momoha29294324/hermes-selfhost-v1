import { createHash } from 'node:crypto';
import { envBool } from '@/lib/env';
import { loadModelRouting } from '@/lib/config/load';
import { CodexCliProvider } from '@/lib/models/providers/codexCli';
import { OpenAiCompatibleProvider } from '@/lib/models/providers/openaiCompatible';
import { EMPTY_USAGE, LlmError, type LlmProvider, type LlmRequest, type LlmUsage } from '@/lib/models/types';
import type { ModelRoute, ModelRoutingConfig } from '@/lib/config/schema';
import type { Sql } from '@/lib/db/sql';
import type { Logger } from '@/lib/logging/logger';

export interface RouterDeps {
  sql: Sql | null;
  logger: Logger;
  routing?: ModelRoutingConfig;
  providers?: Record<string, LlmProvider>;
  /** Hard ceiling on LLM calls for one run. */
  maxCalls?: number;
}

/** What one attempt cost and how it ended. Recorded whatever the outcome. */
export interface AttemptRecord {
  attempt: number;
  status: 'ok' | 'timeout' | 'invalid_output' | 'provider_error' | 'unavailable';
  timeoutMs: number;
  durationMs: number;
  schemaValid: boolean | null;
  usage: LlmUsage;
  errorKind: string | null;
  error: string | null;
  startedAt: Date;
  finishedAt: Date;
}

export interface LlmOutcome<T> {
  ok: boolean;
  data: T | null;
  raw: string | null;
  modelRunId: string | null;
  route: ModelRoute;
  error?: string;
  durationMs: number;
  /** One entry per attempt, in order. Empty when the call was skipped. */
  attempts: AttemptRecord[];
  /** Usage of the attempt that succeeded, or of the last one that reported any. */
  usage: LlmUsage;
}

/**
 * Per-attempt timeouts, in order.
 *
 * R5 gave every attempt the same 180 s, which is why one dead call could hold a
 * prospect for six minutes: the retry inherited the deadline that had just been
 * proved too long. A schedule instead of a single number lets the second attempt
 * be *shorter* — a call that will answer usually answers early, so the retry is
 * there to catch a transient failure, not to wait out the same wall again.
 *
 * The values themselves are configuration, not conviction: §16 requires them to
 * come from measurement, so the type exists here and the numbers live in
 * config/models.json.
 */
export type TimeoutSchedule = number[];

export function timeoutForAttempt(route: ModelRoute, attempt: number): number {
  const schedule = route.timeoutScheduleMs;
  if (!schedule || schedule.length === 0) return route.timeoutMs;
  // Attempts beyond the schedule reuse its last value rather than falling back
  // to the (longer) default, which would silently undo the bound.
  return schedule[Math.min(attempt, schedule.length) - 1] ?? route.timeoutMs;
}

/**
 * Chooses the provider/model/effort for a task from config/models.json, executes
 * the call, validates the JSON answer, and records a model_runs row every time —
 * success, failure, skip. No model name is ever hardcoded in business code.
 *
 * R5.1 added a second, finer ledger: one `llm_attempts` row per attempt. The
 * reason is in the migration — a run that timed out once and succeeded on retry
 * was recorded as a plain success, so R5 reported 2 timeouts where it had paid
 * for about 16.
 */
export class ModelRouter {
  private readonly routing: ModelRoutingConfig;
  private readonly providers: Record<string, LlmProvider>;
  private calls = 0;

  constructor(private readonly deps: RouterDeps) {
    this.routing = deps.routing ?? loadModelRouting();
    this.providers = deps.providers ?? {
      codex: new CodexCliProvider(),
      openai_compatible: new OpenAiCompatibleProvider(),
    };
  }

  get callCount(): number {
    return this.calls;
  }

  routeFor(task: string): ModelRoute {
    const override = this.routing.tasks[task];
    const base = this.routing.defaultRoute;
    if (!override) return base;
    return {
      provider: override.provider ?? base.provider,
      model: override.model ?? base.model,
      effort: override.effort === undefined ? base.effort : override.effort,
      timeoutMs: override.timeoutMs ?? base.timeoutMs,
      maxAttempts: override.maxAttempts ?? base.maxAttempts,
      ...(override.timeoutScheduleMs ?? base.timeoutScheduleMs
        ? { timeoutScheduleMs: override.timeoutScheduleMs ?? base.timeoutScheduleMs }
        : {}),
    };
  }

  /** Runs a task and parses the JSON answer against `parse`. Never throws. */
  async run<T>(
    request: LlmRequest,
    parse: (value: unknown) => T,
  ): Promise<LlmOutcome<T>> {
    return this.runWithRoute(this.routeFor(request.task), request, parse);
  }

  /**
   * Same contract as `run`, with the route supplied by the caller.
   *
   * Exists for the benchmark harness, which has to drive the same prompt through
   * a dozen (model, effort, timeout) combinations. Giving it this entry point is
   * what keeps `config/models.json` the only place production picks a model:
   * the alternative — rewriting the config file between variants — would make
   * the benchmark and the pipeline disagree about what "the route" means.
   */
  async runWithRoute<T>(
    route: ModelRoute,
    request: LlmRequest,
    parse: (value: unknown) => T,
  ): Promise<LlmOutcome<T>> {
    const started = Date.now();
    const inputHash = hashRequest(route, request);
    const attempts: AttemptRecord[] = [];

    const skip = async (error: string, reason: string): Promise<LlmOutcome<T>> => {
      await this.record(request, route, inputHash, 'skipped', null, reason, 0, attempts);
      return {
        ok: false,
        data: null,
        raw: null,
        modelRunId: null,
        route,
        error,
        durationMs: 0,
        attempts,
        usage: { ...EMPTY_USAGE },
      };
    };

    if (envBool('OUTBOUND_LLM_DISABLED', false)) return skip('llm_disabled', 'OUTBOUND_LLM_DISABLED=1');
    if (route.provider === 'none') return skip('route_none', 'route provider is "none"');
    if (this.deps.maxCalls !== undefined && this.calls >= this.deps.maxCalls) {
      return skip('budget_exhausted', 'llm call budget exhausted');
    }

    const provider = this.providers[route.provider];
    if (!provider) {
      await this.record(
        request,
        route,
        inputHash,
        'error',
        null,
        `unknown provider ${route.provider}`,
        0,
        attempts,
      );
      return {
        ok: false,
        data: null,
        raw: null,
        modelRunId: null,
        route,
        error: 'unknown_provider',
        durationMs: 0,
        attempts,
        usage: { ...EMPTY_USAGE },
      };
    }

    const availability = provider.availability();
    if (!availability.ok) {
      return skip(availability.reason ?? 'provider_unavailable', availability.reason ?? 'unavailable');
    }

    let lastError: string | undefined;
    for (let attempt = 1; attempt <= route.maxAttempts; attempt += 1) {
      this.calls += 1;
      const attemptTimeoutMs = timeoutForAttempt(route, attempt);
      const attemptStarted = new Date();
      const attemptStartedMs = Date.now();

      try {
        const generation = await provider.generate(request, { ...route, timeoutMs: attemptTimeoutMs });
        const usage = generation.usage ?? { ...EMPTY_USAGE };
        // Parsing failures are attributed to the schema, not to the provider:
        // "the model answered but not in the shape we asked for" is a different
        // defect from "the model did not answer", and merging them would hide
        // the one a stricter schema could fix.
        const value = extractJson(generation.text);
        const data = parse(value);

        attempts.push({
          attempt,
          status: 'ok',
          timeoutMs: attemptTimeoutMs,
          durationMs: Date.now() - attemptStartedMs,
          schemaValid: request.schema ? true : null,
          usage,
          errorKind: null,
          error: null,
          startedAt: attemptStarted,
          finishedAt: new Date(),
        });

        const durationMs = Date.now() - started;
        const modelRunId = await this.record(
          request,
          route,
          inputHash,
          'ok',
          data,
          null,
          durationMs,
          attempts,
        );
        return { ok: true, data, raw: generation.text, modelRunId, route, durationMs, attempts, usage };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        const kind = error instanceof LlmError ? error.kind : 'provider_error';
        const status: AttemptRecord['status'] =
          kind === 'timeout'
            ? 'timeout'
            : kind === 'invalid_output'
              ? 'invalid_output'
              : kind === 'unavailable'
                ? 'unavailable'
                : 'provider_error';

        attempts.push({
          attempt,
          status,
          timeoutMs: attemptTimeoutMs,
          durationMs: Date.now() - attemptStartedMs,
          schemaValid: request.schema ? (status === 'invalid_output' ? false : null) : null,
          usage: { ...EMPTY_USAGE },
          errorKind: kind,
          error: lastError,
          startedAt: attemptStarted,
          finishedAt: new Date(),
        });

        this.deps.logger.warn('llm.attempt_failed', {
          task: request.task,
          attempt,
          model: route.model,
          effort: route.effort,
          timeoutMs: attemptTimeoutMs,
          kind,
          error: lastError,
        });
        if (kind === 'unavailable') break;
      }
    }

    const durationMs = Date.now() - started;
    const status = attempts.some((entry) => entry.status === 'timeout') ? 'timeout' : 'error';
    const modelRunId = await this.record(
      request,
      route,
      inputHash,
      status,
      null,
      lastError ?? 'unknown',
      durationMs,
      attempts,
    );
    return {
      ok: false,
      data: null,
      raw: null,
      modelRunId,
      route,
      error: lastError,
      durationMs,
      attempts,
      usage: { ...EMPTY_USAGE },
    };
  }

  private async record(
    request: LlmRequest,
    route: ModelRoute,
    inputHash: string,
    status: 'ok' | 'error' | 'skipped' | 'timeout',
    output: unknown,
    error: string | null,
    durationMs: number,
    attempts: AttemptRecord[],
  ): Promise<string | null> {
    if (!this.deps.sql) return null;

    const successful = attempts.find((entry) => entry.status === 'ok');
    // The successful attempt's usage is what the answer cost. A failed attempt
    // that reported tokens is still counted at the attempt level — it is a real
    // expense — but attributing it to the run would make a retried success look
    // more expensive than the same call made once, which is the opposite of
    // what the run-level number is for.
    const usage = successful?.usage ?? { ...EMPTY_USAGE };
    const timeouts = attempts.filter((entry) => entry.status === 'timeout').length;

    const rows = await this.deps.sql.query<{ id: string }>(
      `insert into model_runs
         (task, provider, model, effort, input_ref, input_hash, prompt_chars, status, output, error,
          duration_ms, tokens_input, tokens_output, tokens_cached_input, tokens_cache_write,
          tokens_reasoning, attempts, timeouts)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       returning id`,
      [
        request.task,
        route.provider,
        route.model,
        route.effort,
        request.inputRef ?? null,
        inputHash,
        request.prompt.length,
        status,
        output === null || output === undefined ? null : JSON.stringify(output),
        error,
        durationMs,
        usage.tokensInput,
        usage.tokensOutput,
        usage.tokensCachedInput,
        usage.tokensCacheWrite,
        usage.tokensReasoning,
        attempts.length,
        timeouts,
      ],
    );

    const modelRunId = rows[0]?.id ?? null;
    for (const entry of attempts) {
      await this.deps.sql.query(
        `insert into llm_attempts
           (model_run_id, task, provider, model, effort, input_ref, input_hash, attempt, status,
            timeout_ms, duration_ms, schema_valid, prompt_chars, tokens_input, tokens_cached_input,
            tokens_cache_write, tokens_output, tokens_reasoning, error_kind, error,
            started_at, finished_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [
          modelRunId,
          request.task,
          route.provider,
          route.model,
          route.effort,
          request.inputRef ?? null,
          inputHash,
          entry.attempt,
          entry.status,
          entry.timeoutMs,
          entry.durationMs,
          entry.schemaValid,
          request.prompt.length,
          entry.usage.tokensInput,
          entry.usage.tokensCachedInput,
          entry.usage.tokensCacheWrite,
          entry.usage.tokensOutput,
          entry.usage.tokensReasoning,
          entry.errorKind,
          entry.error,
          entry.startedAt.toISOString(),
          entry.finishedAt.toISOString(),
        ],
      );
    }
    return modelRunId;
  }
}

/**
 * The identity of a call, for deduplication and for benchmark resume (§19).
 *
 * Covers everything that can change the answer for a reason we care about:
 * route, system prompt, user prompt and the schema the answer must satisfy.
 * The schema is included because R5 omitted it — two variants that differ only
 * by their output shape would have shared a cache entry and one of them would
 * have been credited with the other's result.
 */
export function hashRequest(route: ModelRoute, request: LlmRequest): string {
  return createHash('sha256')
    .update(
      [
        route.provider,
        route.model,
        route.effort ?? '',
        request.system ?? '',
        request.prompt,
        request.schema ? JSON.stringify(request.schema) : '',
      ].join('|'),
    )
    .digest('hex');
}

/** Tolerates models that wrap JSON in prose or fences, without ever guessing values. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));

  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    candidates.push(trimmed.slice(firstBracket, lastBracket + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  throw new LlmError(`model did not return JSON: ${trimmed.slice(0, 200)}`, 'invalid_output');
}
