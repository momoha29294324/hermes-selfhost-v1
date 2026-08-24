import { env } from '@/lib/env';
import { withTimeout } from '@/lib/util/retry';
import {
  EMPTY_USAGE,
  LlmError,
  type LlmGeneration,
  type LlmProvider,
  type LlmRequest,
} from '@/lib/models/types';
import type { ModelRoute } from '@/lib/config/schema';

/**
 * Any OpenAI-compatible /chat/completions endpoint (OpenRouter, a local gateway,
 * a self-hosted proxy…). Configured entirely through the environment so no key
 * ever lands in the repository or in a config file.
 */
interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = 'openai_compatible';

  availability(): { ok: boolean; reason?: string } {
    if (!env('OUTBOUND_OPENAI_BASE_URL')) return { ok: false, reason: 'OUTBOUND_OPENAI_BASE_URL is not set' };
    if (!env('OUTBOUND_OPENAI_API_KEY')) return { ok: false, reason: 'OUTBOUND_OPENAI_API_KEY is not set' };
    return { ok: true };
  }

  async generate(request: LlmRequest, route: ModelRoute): Promise<LlmGeneration> {
    const available = this.availability();
    if (!available.ok) throw new LlmError(available.reason ?? 'provider unavailable', 'unavailable');

    const baseUrl = (env('OUTBOUND_OPENAI_BASE_URL') as string).replace(/\/$/, '');
    const apiKey = env('OUTBOUND_OPENAI_API_KEY') as string;
    const model = route.model === 'default' ? (env('OUTBOUND_OPENAI_DEFAULT_MODEL') ?? route.model) : route.model;

    const body: Record<string, unknown> = {
      model,
      messages: [
        ...(request.system ? [{ role: 'system', content: request.system }] : []),
        { role: 'user', content: request.prompt },
      ],
    };
    if (route.effort) body['reasoning_effort'] = route.effort;
    if (request.schema) {
      body['response_format'] = {
        type: 'json_schema',
        json_schema: { name: 'result', strict: true, schema: request.schema },
      };
    }

    const response = await withTimeout(route.timeoutMs, `${this.name} ${model}`, async (signal) =>
      fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      }),
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new LlmError(`HTTP ${response.status}: ${detail.slice(0, 300)}`, 'provider_error');
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const text = payload.choices?.[0]?.message?.content?.trim();
    if (!text) throw new LlmError('empty completion', 'invalid_output');

    return {
      text,
      usage: {
        ...EMPTY_USAGE,
        tokensInput: payload.usage?.prompt_tokens ?? null,
        tokensOutput: payload.usage?.completion_tokens ?? null,
      },
    };
  }
}
