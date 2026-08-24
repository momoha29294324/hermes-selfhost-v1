/**
 * robots.txt evaluation (RFC 9309), for our own user-agent with a `*` fallback.
 * Longest matching rule wins; Allow beats Disallow at equal length.
 *
 * There is a sibling implementation in the main app at src/lib/http/client.ts.
 * The two exist because the worker is deployed on its own, without the app's
 * module graph. `tests/webintel/robots.test.ts` runs both over one corpus and
 * fails if they ever disagree, so the duplication cannot silently drift.
 */

export const WEBINTEL_UA_TOKEN = 'hermeswebintelbot';

interface RobotsGroup {
  agents: string[];
  rules: { allow: boolean; pattern: string }[];
}

export function parseRobots(robotsTxt: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const rawLine of robotsTxt.split('\n')) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    if (field === 'allow' || field === 'disallow') {
      lastWasAgent = false;
      if (!current) continue;
      current.rules.push({ allow: field === 'allow', pattern: value });
    }
  }
  return groups;
}

export function isPathAllowed(robotsTxt: string, path: string, agent = WEBINTEL_UA_TOKEN): boolean {
  const groups = parseRobots(robotsTxt);
  const specific = groups.find((g) => g.agents.some((a) => a === agent));
  const wildcard = groups.find((g) => g.agents.includes('*'));
  const group = specific ?? wildcard;
  if (!group) return true;

  let best: { allow: boolean; length: number } | null = null;
  for (const rule of group.rules) {
    if (rule.pattern === '') continue;
    if (!matchesPattern(rule.pattern, path)) continue;
    const length = rule.pattern.replace(/\*/g, '').length;
    if (!best || length > best.length || (length === best.length && rule.allow)) {
      best = { allow: rule.allow, length };
    }
  }
  return best ? best.allow : true;
}

function matchesPattern(pattern: string, path: string): boolean {
  const anchoredEnd = pattern.endsWith('$');
  const body = anchoredEnd ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const regex = new RegExp(`^${escaped}${anchoredEnd ? '$' : ''}`);
  return regex.test(path);
}

/** Crawl-delay for the applicable group, in ms. Returns null when unset. */
export function crawlDelayMs(robotsTxt: string, agent = WEBINTEL_UA_TOKEN): number | null {
  let applicable: number | null = null;
  let wildcard: number | null = null;
  let currentAgents: string[] = [];
  let lastWasAgent = false;

  for (const rawLine of robotsTxt.split('\n')) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!lastWasAgent) currentAgents = [];
      currentAgents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field !== 'crawl-delay') continue;
    const seconds = Number.parseFloat(value);
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    if (currentAgents.includes(agent)) applicable = seconds * 1000;
    else if (currentAgents.includes('*')) wildcard = seconds * 1000;
  }
  return applicable ?? wildcard;
}
