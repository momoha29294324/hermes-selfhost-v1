/**
 * Environment access. Reads `.env` once (no dependency on dotenv), never logs values.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

let loaded = false;

function loadDotEnv(): void {
  if (loaded) return;
  loaded = true;
  const path = resolve(process.cwd(), '.env');
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export function env(key: string, fallback?: string): string | undefined {
  loadDotEnv();
  const value = process.env[key];
  if (value === undefined || value === '') return fallback;
  return value;
}

export function envRequired(key: string): string {
  const value = env(key);
  if (value === undefined) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export function envInt(key: string, fallback: number): number {
  const value = env(key);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function envBool(key: string, fallback = false): boolean {
  const value = env(key);
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/** True when a key-bearing provider is configured. Never returns the key itself. */
export function hasSecret(key: string): boolean {
  return env(key) !== undefined;
}
