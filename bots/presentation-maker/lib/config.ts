import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

declare const __VIAN_BOT_ROOT__: string;

export const BOT_ROOT = __VIAN_BOT_ROOT__;
export const REPO_ROOT = resolve(BOT_ROOT, '..', '..');

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2] ?? '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1]!] = value;
  }
  return out;
}

const botEnv = parseEnvFile(join(BOT_ROOT, '.env'));
const repoEnv = parseEnvFile(join(REPO_ROOT, '.env'));

export function env(name: string, fallback = ''): string {
  const fromProcess = process.env[name];
  if (fromProcess !== undefined && fromProcess !== '') return fromProcess;
  const fromBot = botEnv[name];
  if (fromBot !== undefined && fromBot !== '') return fromBot;
  const fromRepo = repoEnv[name];
  if (fromRepo !== undefined && fromRepo !== '') return fromRepo;
  return fallback;
}

export const BASE_URL = env('PRESENTATION_MAKER_BASE_URL', 'http://127.0.0.1:3210').replace(/\/$/, '');
export const WORKER_URL = env('PRESENTATION_MAKER_WORKER_URL', 'http://127.0.0.1:8787').replace(/\/$/, '');
export const API_USERNAME = env('PRESENTATION_MAKER_USERNAME');
export const API_PASSWORD = env('PRESENTATION_MAKER_PASSWORD');
export const ATTACHMENTS_DIR = join(BOT_ROOT, '.vian', 'attachments');
export const LOG_DIR = join(BOT_ROOT, '.vian', 'logs');
export const AI_GATEWAY_API_KEY = env('AI_GATEWAY_API_KEY');
