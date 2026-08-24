#!/usr/bin/env tsx
/**
 * Recomputes the derived `personalization_level` of existing drafts with the
 * current heuristic. Pure post-processing: it re-reads the stored research
 * observations and the stored message body, and never calls a model.
 *
 *   npm run backfill:personalization
 */
import { getSql } from '@/lib/db';
import { personalizationLevel } from '@/lib/pipeline/guardrails';
import { createLogger } from '@/lib/logging/logger';

interface Row {
  id: string;
  prospect_id: string;
  body: string;
  personalization_level: string;
}

async function main(): Promise<void> {
  const logger = createLogger({ cmd: 'backfill:personalization' });
  const sql = await getSql();

  const messages = await sql.query<Row>(
    'select id, prospect_id, body, personalization_level from outreach_messages',
  );

  let changed = 0;
  for (const message of messages) {
    const research = await sql.query<{ observations: { text: string }[] }>(
      'select observations from prospect_research where prospect_id = $1 order by created_at desc limit 1',
      [message.prospect_id],
    );
    const facts = (research[0]?.observations ?? []).map((observation) => observation.text);
    const level = personalizationLevel(message.body, facts);
    if (level === message.personalization_level) continue;
    await sql.query('update outreach_messages set personalization_level = $2, updated_at = now() where id = $1', [
      message.id,
      level,
    ]);
    changed += 1;
  }

  logger.info('backfill.done', { messages: messages.length, changed });
  await sql.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
