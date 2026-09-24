import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { AI_GATEWAY_API_KEY, BASE_URL, BOT_ROOT, LINUX_LOCAL, LOG_DIR, REPO_ROOT, WORKER_URL } from './config.ts';
import { ensureLogin, health } from './api.ts';

async function workerHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${WORKER_URL}/v1/songs`, {
      method: 'GET',
      headers: { Authorization: 'Bearer health-probe' },
      signal: AbortSignal.timeout(1500),
    });
    // Any HTTP answer means the worker is listening (401/200 both fine).
    return response.status > 0;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnDetached(command: string, args: string[], cwd: string, logFile: string, extraEnv: Record<string, string> = {}): number {
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  const out = openSync(logFile, 'a');
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  closeSync(out);
  return child.pid ?? 0;
}

export async function ensureBackend(signal: AbortSignal): Promise<Record<string, unknown>> {
  if (LINUX_LOCAL) {
    const details: Record<string, unknown> = { base: BASE_URL, mode: 'linux-local' };
    let local = await health();
    if (local.ok && local.version !== 'linux-bun-1') return { ...details, ready: false, backendError: 'El puerto pertenece a otro backend. Usa PRESENTATION_MAKER_PORT o detén el proceso anterior.' };
    if (!local.ok) {
      const log = join(LOG_DIR, 'backend.log');
      spawnDetached('bun', ['apps/linux/server.ts'], REPO_ROOT, log, {
        PRESENTATION_MAKER_DATA_DIR: process.env.PRESENTATION_MAKER_DATA_DIR ?? '',
        PRESENTATION_MAKER_PORT: new URL(BASE_URL).port || '3210',
      });
      for (let i = 0; i < 60 && !local.ok; i++) {
        if (signal.aborted) break;
        await sleep(500);
        local = await health();
      }
      details.backendLog = log;
    }
    details.ready = local.ok && local.version === 'linux-bun-1';
    details.version = local.version;
    if (!details.ready) details.backendError = local.error || 'El servidor Bun no quedó listo.';
    return details;
  }
  const details: Record<string, unknown> = { base: BASE_URL, worker: WORKER_URL };

  let worker = await workerHealthy();
  if (!worker) {
    if (!AI_GATEWAY_API_KEY) {
      details.workerError = 'Falta AI_GATEWAY_API_KEY para arrancar el Worker local.';
    } else {
      const log = join(LOG_DIR, 'worker.log');
      spawnDetached(
        'npx',
        ['wrangler', 'dev', '--port', new URL(WORKER_URL).port || '8787', '--ip', '127.0.0.1'],
        join(REPO_ROOT, 'apps', 'worker'),
        log,
        { AI_GATEWAY_API_KEY, WRANGLER_SEND_METRICS: 'false' },
      );
      for (let i = 0; i < 40 && !worker; i += 1) {
        if (signal.aborted) break;
        await sleep(500);
        worker = await workerHealthy();
      }
      details.workerStarted = worker;
      details.workerLog = log;
    }
  } else {
    details.workerStarted = true;
  }

  let local = await health();
  if (!local.ok) {
    const log = join(LOG_DIR, 'backend.log');
    spawnDetached('go', ['run', '.'], join(REPO_ROOT, 'apps', 'local'), log, {
      PRESENTATION_MAKER_API_URL: WORKER_URL,
      PRESENTATION_MAKER_DATA_DIR: process.env.PRESENTATION_MAKER_DATA_DIR ?? '',
    });
    for (let i = 0; i < 60 && !local.ok; i += 1) {
      if (signal.aborted) break;
      await sleep(500);
      local = await health();
    }
    details.backendStarted = local.ok;
    details.backendLog = log;
  } else {
    details.backendStarted = true;
  }
  details.version = local.version;
  details.backendError = local.ok ? undefined : local.error;

  if (local.ok) {
    try {
      const user = await ensureLogin(signal);
      details.user = user;
      details.ready = Boolean(worker);
      if (!worker) details.ready = false;
    } catch (error) {
      details.ready = false;
      details.authError = error instanceof Error ? error.message : String(error);
    }
  } else {
    details.ready = false;
  }

  if (!BOT_ROOT) details.botRootMissing = true;
  return details;
}
