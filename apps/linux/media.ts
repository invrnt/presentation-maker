import { spawn } from 'node:child_process';

export const MEDIA_PROFILE = 'pptx-h264-aac-16x9-v3';
export function mediaTimeout(): number {
  const hours = Number(process.env.PRESENTATION_MAKER_MEDIA_TIMEOUT_HOURS ?? 6);
  if (!Number.isFinite(hours) || hours < 0) throw new Error('PRESENTATION_MAKER_MEDIA_TIMEOUT_HOURS debe ser un número >= 0.');
  return hours * 3600_000;
}

// Drain both pipes, keeping diagnostics bounded even for multi-hour videos.
export async function command(args: string[], timeout = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let out = '', err = '', expired = false, overflow = false;
    const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = timeout > 0 ? setTimeout(() => { expired = true; kill(); }, timeout) : undefined;
    child.stdout.on('data', (data) => {
      if (out.length + data.length > 16 * 1024 * 1024) { overflow = true; kill(); }
      else out += data.toString();
    });
    child.stderr.on('data', (data) => { err = (err + data.toString()).slice(-32_768); });
    child.on('error', (error) => { clearTimeout(timer); reject(new Error(`No se pudo ejecutar ${args[0]}: ${error.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (expired) reject(new Error('Tiempo máximo de procesamiento agotado. Aumenta PRESENTATION_MAKER_MEDIA_TIMEOUT_HOURS y reintenta.'));
      else if (overflow) reject(new Error(`${args[0]} devolvió demasiados datos de diagnóstico.`));
      else if (code !== 0) reject(new Error((err || out).trim() || `${args[0]} terminó con código ${code}`));
      else resolve(out);
    });
  });
}

export function mediaFailure(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  const rules: [RegExp, string, boolean, string][] = [
    [/se reinició/i, 'INTERRUPTED', true, 'El backend se reinició. Vuelve a preparar el video.'],
    [/ENOSPC|No space left/i, 'DISK_FULL', false, 'No hay suficiente espacio en disco. Libera espacio y vuelve a preparar el video.'],
    [/ENOENT|No se pudo ejecutar|dependencias/i, 'DEPENDENCY_MISSING', false, 'Faltan herramientas de video. Ejecuta el instalador y revisa /api/media/health.'],
    [/private video|sign in|login|cookies|bot|age.restrict|403|429/i, 'ACCESS_RESTRICTED', false, 'YouTube restringió el acceso. Comprueba que el video sea público y actualiza yt-dlp con presentation-maker update.'],
    [/removed|unavailable|not available|copyright|geo.?restrict/i, 'UNAVAILABLE', false, 'El video o algún fragmento no está disponible. Comprueba el enlace y su disponibilidad en este host.'],
    [/Tiempo máximo|timed? ?out|timeout|network|connection|HTTP Error 5|temporary failure/i, 'NETWORK_OR_TIMEOUT', true, 'La conexión o el procesamiento agotó su tiempo. Puedes reintentar.'],
    [/Invalid data|corrupt|decode|no tiene video|validación/i, 'INVALID_MEDIA', false, 'El archivo no pudo validarse como video completo y compatible. Prueba otra fuente.'],
  ];
  const rule = rules.find(([pattern]) => pattern.test(detail));
  return { code: rule?.[1] || 'MEDIA_FAILED', retryable: rule?.[2] ?? false, message: rule?.[3] || 'No se pudo preparar el video. Revisa el diagnóstico del backend.',
    // Do not expose signed source URLs in persisted jobs or agent responses.
    detail: detail.replace(/https?:\/\/[^\s]+/g, '[URL]').slice(-4000) };
}

export async function checkMediaTools() {
  const errors: string[] = [];
  for (const args of [['ffprobe', '-version'], ['yt-dlp', '--version'], ['deno', '--version']]) {
    try { await command(args, 10_000); } catch { errors.push(`Falta ${args[0]} o no puede ejecutarse.`); }
  }
  try {
    // Exercise actual encoders and HDR filters, not merely the binary's presence.
    await command(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=16x16:d=0.1', '-f', 'lavfi', '-i', 'anullsrc', '-t', '0.1', '-vf', 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=limited,zscale=transfer=linear,format=gbrpf32le,tonemap=tonemap=hable,zscale=transfer=bt709:primaries=bt709:matrix=bt709,format=yuv420p', '-c:v', 'libx264', '-c:a', 'aac', '-f', 'null', '-'], 15_000);
  } catch { errors.push('FFmpeg requiere libx264, AAC, zscale y tonemap. Instala el paquete ffmpeg completo.'); }
  return { ready: !errors.length, errors, profile: MEDIA_PROFILE };
}
let toolsCache: { time: number; value: ReturnType<typeof checkMediaTools> } | undefined;
export function mediaTools() {
  if (!toolsCache || Date.now() - toolsCache.time > 30_000) toolsCache = { time: Date.now(), value: checkMediaTools() };
  return toolsCache.value;
}

export const downloadOptions = ['--ignore-config', '--no-playlist', '--no-progress', '--no-colors', '--socket-timeout', '30', '--retries', '8', '--fragment-retries', '8', '--extractor-retries', '3', '--retry-sleep', 'http:exp=1:20', '--retry-sleep', 'fragment:exp=1:20', '--abort-on-unavailable-fragments'];
export const formatOptions = ['-f', 'bv*+ba/bv*/b', '--format-sort-force', '-S', 'res~1080,hdr:SDR,vcodec:h264,acodec:aac'];
export async function probe(path: string) {
  return JSON.parse(await command(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]));
}
export async function normalizeVideo(source: string, target: string) {
  const info = await probe(source);
  const video = info.streams.find((s: any) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) throw new Error('El archivo no tiene video.');
  const audio = info.streams.find((s: any) => s.codec_type === 'audio');
  const hdr = ['smpte2084', 'arib-std-b67'].includes(video.color_transfer);
  const filters = [
    ...(hdr ? ['zscale=transfer=linear:npl=100', 'format=gbrpf32le', 'zscale=primaries=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=transfer=bt709:matrix=bt709:range=limited'] : []),
    // Keep orientation and aspect ratio; never enlarge a smaller source.
    "scale=w='max(2,trunc(iw*sar/2)*2)':h='max(2,trunc(ih/2)*2)'", 'setsar=1',
    "scale=w='if(gte(iw,ih),min(1920,iw),min(1080,iw))':h='if(gte(iw,ih),min(1080,ih),min(1920,ih))':force_original_aspect_ratio=decrease:force_divisible_by=2",
    // Fill 16:9 by centered cropping, never stretch; retain small-source resolution.
    'scale=w=max(32\\,iw):h=max(18\\,ih):force_original_aspect_ratio=increase',
    "crop=w='trunc(min(iw,ih*16/9)/32)*32':h='trunc(min(ih,iw*9/16)/18)*18'",
    'setsar=1', 'fps=30', 'format=yuv420p',
  ];
  await command(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-xerror', '-i', source, '-map', `0:${video.index}`, ...(audio ? ['-map', `0:${audio.index}`] : []), '-sn', '-dn', '-map_metadata', '-1', '-vf', filters.join(','), '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '22', '-maxrate', '20M', '-bufsize', '40M', '-profile:v', 'high', '-level:v', '4.1', '-pix_fmt', 'yuv420p', '-tag:v', 'avc1', '-c:a', 'aac', '-profile:a', 'aac_low', '-ac', '2', '-ar', '48000', '-b:a', '160k', '-movflags', '+faststart', target], mediaTimeout());
  const result = await probe(target);
  const v = result.streams.find((s: any) => s.codec_type === 'video');
  const a = result.streams.find((s: any) => s.codec_type === 'audio');
  if (!v || v.codec_name !== 'h264' || v.pix_fmt !== 'yuv420p' || v.codec_tag_string !== 'avc1' || !(Number(result.format.duration) > 0) || (audio && !a) || (a && (a.codec_name !== 'aac' || a.channels > 2))) throw new Error('Falló la validación del MP4 normalizado.');
  const duration = Number(info.format.duration);
  if (duration > 0 && Math.abs(Number(result.format.duration) - duration) > Math.max(2, duration * 0.01)) throw new Error('Falló la validación: duración incompleta.');
  // Decode the entire result before publication; a probe alone misses corrupt frames.
  await command(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-i', target, '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-'], mediaTimeout());
  return { width: v.width, height: v.height, durationSeconds: Number(result.format.duration) };
}
