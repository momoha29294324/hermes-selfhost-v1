import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '@/lib/env';
import {
  EMPTY_USAGE,
  LlmError,
  type LlmGeneration,
  type LlmProvider,
  type LlmRequest,
  type LlmUsage,
} from '@/lib/models/types';
import type { ModelRoute } from '@/lib/config/schema';

/**
 * Provider backed by the locally installed Codex CLI.
 *
 * Why a CLI rather than an HTTP client: the machine is already authenticated
 * through `codex login`, so this app never reads, stores or transmits an API key.
 *
 * Isolation choices:
 *   --ignore-user-config  do not load ~/.codex/config.toml (no plugins, no MCP
 *                         servers, no hooks from other projects) — also ~4x faster
 *   --ephemeral           do not persist session files
 *   --sandbox read-only   the model cannot write anything, anywhere
 *   -C <tmpdir>           its working root is a scratch directory, never our repo
 *
 * R5.1 added `--json`. The human footer it replaces ("tokens used\n6 630") is a
 * single aggregate that the non-interactive mode did not always print — which is
 * why every `model_runs` row of the R5 corpus carries a null token count. The
 * JSONL stream publishes `turn.completed` with the real breakdown, so cost can
 * be measured instead of guessed. The answer is still read from `-o`: it is the
 * agent's final message verbatim, and depending on the event stream for it would
 * trade a documented contract for a parsed one.
 */
export class CodexCliProvider implements LlmProvider {
  readonly name = 'codex';

  availability(): { ok: boolean; reason?: string } {
    return { ok: true };
  }

  async generate(request: LlmRequest, route: ModelRoute): Promise<LlmGeneration> {
    const bin = env('OUTBOUND_CODEX_BIN', 'codex') as string;
    const dir = mkdtempSync(join(tmpdir(), 'hermes-llm-'));
    const outputPath = join(dir, 'last-message.txt');
    const schemaPath = join(dir, 'schema.json');

    const args = [
      'exec',
      '--ignore-user-config',
      '--ignore-rules',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--color',
      'never',
      '--json',
      '-C',
      dir,
      '-m',
      route.model,
      '-o',
      outputPath,
    ];
    if (route.effort) args.push('-c', `model_reasoning_effort=${route.effort}`);
    if (request.schema) {
      writeFileSync(schemaPath, JSON.stringify(request.schema), 'utf8');
      args.push('--output-schema', schemaPath);
    }
    // Read the prompt from stdin so size is not bounded by argv limits.
    args.push('-');

    const prompt = request.system ? `${request.system}\n\n---\n\n${request.prompt}` : request.prompt;

    try {
      const { stdout, code, timedOut } = await runProcess(bin, args, prompt, route.timeoutMs);
      if (timedOut) throw new LlmError(`codex exec timed out after ${route.timeoutMs}ms`, 'timeout');
      if (!existsSync(outputPath)) {
        throw new LlmError(
          `codex exec produced no output (exit ${code}): ${stdout.slice(-400)}`,
          'provider_error',
        );
      }
      const text = readFileSync(outputPath, 'utf8').trim();
      if (!text) throw new LlmError('codex exec returned an empty message', 'invalid_output');
      return { text, usage: parseUsage(stdout) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

interface TurnUsage {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  cache_write_input_tokens?: unknown;
  output_tokens?: unknown;
  reasoning_output_tokens?: unknown;
}

/**
 * Reads the token breakdown from the `--json` event stream.
 *
 * Summed across turns rather than keeping the last event: a call the CLI splits
 * into several turns really consumed all of them, and keeping only the last
 * would under-report exactly the long calls R5.1 exists to make cheaper.
 *
 * An absent or unparsable event yields nulls, never zeros — "not reported" and
 * "cost nothing" are different facts, and a benchmark that confuses them
 * flatters whichever model failed to report.
 */
export function parseUsage(stdout: string): LlmUsage {
  const totals: LlmUsage = { ...EMPTY_USAGE };
  let seen = false;

  const toCount = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('turn.completed')) continue;

    let event: { type?: unknown; usage?: TurnUsage } | null = null;
    try {
      event = JSON.parse(trimmed) as { type?: unknown; usage?: TurnUsage };
    } catch {
      continue;
    }
    if (event?.type !== 'turn.completed' || !event.usage) continue;

    const usage = event.usage;
    const add = (key: keyof LlmUsage, value: unknown): void => {
      const count = toCount(value);
      if (count === null) return;
      totals[key] = (totals[key] ?? 0) + count;
      seen = true;
    };
    add('tokensInput', usage.input_tokens);
    add('tokensCachedInput', usage.cached_input_tokens);
    add('tokensCacheWrite', usage.cache_write_input_tokens);
    add('tokensOutput', usage.output_tokens);
    add('tokensReasoning', usage.reasoning_output_tokens);
  }

  if (seen) return totals;

  // No structured event: fall back to the human footer rather than to silence.
  const footer = parseTokenUsage(stdout);
  return footer.tokensOutput === undefined
    ? { ...EMPTY_USAGE }
    : { ...EMPTY_USAGE, tokensOutput: footer.tokensOutput };
}

/**
 * The pre-R5.1 human footer, kept because a `--json` stream that a future CLI
 * version stops emitting should degrade to the old aggregate rather than to
 * nothing. Never a substitute for `parseUsage`: it reports one total, not a
 * breakdown, so it cannot answer "how much of this was cached".
 */
export function parseTokenUsage(stdout: string): { tokensOutput?: number | null } {
  const match = stdout.match(/tokens used\s*\n\s*([\d\s,.  ]+)/i);
  if (!match?.[1]) return {};
  const digits = match[1].replace(/[^\d]/g, '');
  if (!digits) return {};
  const value = Number.parseInt(digits, 10);
  return Number.isFinite(value) ? { tokensOutput: value } : {};
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/**
 * Runs a child process with a deadline that actually holds.
 *
 * Two traps, both of which hung a full campaign run before this was fixed:
 *
 *  1. The CLI is a launcher: it spawns a native binary underneath. Killing the
 *     launcher alone orphans that binary, which keeps running and keeps the
 *     inherited stdio pipes open. So the child is started as its own process
 *     group leader (`detached`) and the whole group is signalled.
 *  2. Node's `close` event waits for every stdio stream to close — an orphan
 *     holding a pipe means `close` never fires. Settling on `exit` (which fires
 *     on termination regardless of stdio), plus a hard backstop timer, makes it
 *     impossible for one bad call to block the pipeline forever.
 */
export function runProcess(
  bin: string,
  args: string[],
  stdin: string,
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const settle = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(backstop);
      resolve(result);
    };

    const killGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    // If neither `exit` nor `close` arrives after the kill, give up anyway.
    const backstop = setTimeout(() => {
      timedOut = true;
      killGroup();
      settle({ stdout, stderr, code: null, timedOut: true });
    }, timeoutMs + 10_000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(backstop);
      reject(new LlmError(`failed to spawn ${bin}: ${error.message}`, 'unavailable'));
    });
    child.on('exit', (code) => {
      // Let any buffered output flush, then settle without waiting for pipes
      // that an orphaned grandchild may be holding open.
      setTimeout(() => settle({ stdout, stderr, code, timedOut }), 50);
    });

    child.stdin.on('error', () => undefined);
    child.stdin.write(stdin);
    child.stdin.end();
  });
}
