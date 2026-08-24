import { describe, expect, it } from 'vitest';
import { CLASSIFICATION_SCHEMA } from '@/lib/pipeline/classify';
import { RESEARCH_SCHEMA } from '@/lib/pipeline/research';
import { ANGLE_SCHEMA } from '@/lib/pipeline/angle';
import { MESSAGE_SCHEMA } from '@/lib/pipeline/message';
import { WORKER_SCHEMA } from '@/lib/pipeline/workers/workers';
import { CONVERSATION_REPAIR_SCHEMA, CONVERSATION_TURN_SCHEMA } from '@/lib/conversation/turn';
import { CONVERSATION_DRAFT_SCHEMA } from '@/lib/conversation/brain';
import { REPLY_DRAFT_SCHEMA } from '@/lib/replies/draft';

/**
 * The provider validates structured-output schemas in strict mode and rejects
 * the request outright when an object declares a property that is missing from
 * `required` — which silently disables a whole pipeline stage at runtime.
 * This test makes that failure impossible to ship.
 */
type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean;
};

function walk(schema: JsonSchema, path: string, problems: string[]): void {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];

  if (types.includes('object')) {
    const properties = Object.keys(schema.properties ?? {});
    const required = schema.required ?? [];
    for (const property of properties) {
      if (!required.includes(property)) problems.push(`${path}: "${property}" absent de required`);
    }
    if (schema.additionalProperties !== false) {
      problems.push(`${path}: additionalProperties doit valoir false`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      walk(child, `${path}.${key}`, problems);
    }
  }

  if (types.includes('array') && schema.items) walk(schema.items, `${path}[]`, problems);
}

const SCHEMAS: [string, unknown][] = [
  ['classification', CLASSIFICATION_SCHEMA],
  ['research', RESEARCH_SCHEMA],
  ['angle', ANGLE_SCHEMA],
  ['message', MESSAGE_SCHEMA],
  ['worker', WORKER_SCHEMA],
  ['conversation_turn', CONVERSATION_TURN_SCHEMA],
  ['conversation_repair', CONVERSATION_REPAIR_SCHEMA],
  ['conversation_draft', CONVERSATION_DRAFT_SCHEMA],
  ['reply_draft', REPLY_DRAFT_SCHEMA],
];

describe('structured output schemas', () => {
  for (const [name, schema] of SCHEMAS) {
    it(`${name} satisfies strict mode`, () => {
      const problems: string[] = [];
      walk(schema as JsonSchema, name, problems);
      expect(problems).toEqual([]);
    });
  }

  it('expresses the optional message variant as a nullable object', () => {
    const variantB = (MESSAGE_SCHEMA as unknown as JsonSchema).properties?.['variant_b'];
    expect(Array.isArray(variantB?.type) ? variantB?.type : []).toContain('null');
  });
});
