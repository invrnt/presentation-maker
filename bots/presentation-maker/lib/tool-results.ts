import { ApiError } from './api.ts';

export function toolFailure(error: unknown, signal: AbortSignal) {
  signal.throwIfAborted();
  const failure = error instanceof ApiError && error.failure
    ? error.failure
    : { code: 'OPERATION_FAILED', message: 'No se pudo completar la operación. Comprueba el backend y los medios requeridos.', retryable: false };
  return { ok: false as const, failure: { code: failure.code, message: failure.message, retryable: failure.retryable },
    ...(error instanceof ApiError && error.jobId ? { jobId: error.jobId } : {}) };
}

export function exportLimit(bytes: number, manifest: { attachments?: { maxFileBytes?: number }; gate?: { telegram?: { localApi?: boolean; apiRoot?: string } } }) {
  const telegram = manifest.gate?.telegram;
  const local = telegram?.localApi && telegram.apiRoot && new URL(telegram.apiRoot).hostname !== 'api.telegram.org';
  if (bytes > 250 * 1024 * 1024) return { code: 'PPTX_TOO_LARGE', message: 'El PPTX supera 250 MiB. Divide la presentación o reduce la duración de los videos.' };
  if (bytes > 50 * 1024 * 1024 && !local) return { code: 'TELEGRAM_LOCAL_API_REQUIRED', message: 'El PPTX está generado, pero para enviar más de 50 MiB se requiere configurar Telegram Bot API local.' };
  if (bytes > (manifest.attachments?.maxFileBytes ?? 50 * 1024 * 1024)) return { code: 'ATTACHMENT_LIMIT', message: 'El PPTX está generado, pero excede maxFileBytes del bot. Configura el límite de adjuntos a 262144000 para admitir 250 MiB.' };
  return undefined;
}
