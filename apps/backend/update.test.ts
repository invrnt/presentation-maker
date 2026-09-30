import { afterEach, expect, test } from 'bun:test';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporary: string[] = [];
afterEach(async () => { for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function run(args: string[], env: Record<string, string | undefined>, cwd?: string) {
  const process = Bun.spawn(args, { env, cwd, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  return { code, stdout, stderr };
}

async function fixture(layoutRules = false) {
  const root = await mkdtemp(join(tmpdir(), 'pm-update-'));
  temporary.push(root);
  const target = join(root, 'custom installation');
  const release = join(root, 'release');
  const pkg = join(root, 'package');
  const mocks = join(root, 'mocks');
  const config = join(root, 'config');
  const commands = join(root, 'commands');
  const bot = 'bots/presentation-maker';
  for (const dir of [join(target, 'apps/backend'), join(target, bot, '.vian'), join(pkg, 'apps/backend'), join(pkg, bot, 'lib'), release, mocks, join(config, 'systemd/user')]) await mkdir(dir, { recursive: true });
  const saved = {
    [`${bot}/vian.json`]: '{"model":"custom-model","gate":"custom-gate"}',
    [`${bot}/.env`]: 'TELEGRAM_BOT_TOKEN=test-only-placeholder',
    [`${bot}/VIAN.md`]: 'Mis instrucciones personalizadas',
    [`${bot}/.vian/session.json`]: '{"history":"keep"}',
    '.env': 'CUSTOM_SETTING=keep',
  };
  for (const [file, contents] of Object.entries(saved)) await writeFile(join(target, file), contents);
  const unit = join(config, 'systemd/user/presentation-maker-vian-backend.service');
  const unitContents = '[Service]\nEnvironment=PRESENTATION_MAKER_PORT=4321\n';
  await writeFile(unit, unitContents);
  await writeFile(join(root, 'projects.db'), 'existing-projects');
  await writeFile(join(target, 'apps/backend/server.js'), 'old backend');
  await cp(join(import.meta.dir, 'install.sh'), join(pkg, 'install.sh'));
  await cp(join(import.meta.dir, 'presentation-maker'), join(pkg, 'presentation-maker'));
  for (const file of ['apps/backend/server.js', 'apps/backend/template.pptx', 'apps/backend/README.md', `${bot}/vian.tools.ts`, `${bot}/lib/api.ts`, `${bot}/VIAN.md`, `${bot}/vian.json`, `${bot}/README.md`]) await writeFile(join(pkg, file), 'new release');
  const script = async (file: string, source: string) => { await writeFile(file, '#!/usr/bin/env bash\nset -euo pipefail\n' + source); await chmod(file, 0o755); };
  await script(join(mocks, 'curl'), `url=''; output=''
while (($#)); do
  case "$1" in https://*) url="$1" ;; -o) shift; output="$1" ;; esac
  shift
done
if [[ "$url" == https://api.github.com/* ]]; then printf '{"tag_name":"v9.8.7"}'; exit; fi
asset="\${url##*/}"
if [[ -n "\${FAIL_DENO:-}" && "$asset" == deno-*.zip ]]; then exit 22; fi
cp "$FIXTURE_RELEASE_DIR/$asset" "$output"
`);
  await script(join(mocks, 'systemctl'), 'printf "%s\\n" "$*" >> "$FIXTURE_SERVICE_LOG"\n');
  await script(join(mocks, 'sudo'), 'echo "Unexpected sudo invocation" >&2; exit 99\n');
  for (const name of ['ffmpeg', 'ffprobe']) await script(join(mocks, name), 'exit 0\n');
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const ytAsset = arch === 'aarch64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
  const denoAsset = `deno-${arch}-unknown-linux-gnu.zip`;
  await script(join(release, ytAsset), 'echo 2026.08.19\n');
  await script(join(release, 'deno'), 'echo "deno 2.9.7"\n');
  if (layoutRules) await cp(join(import.meta.dir, '../../bots/presentation-maker/VIAN.md'), join(pkg, bot, 'VIAN.md'));
  const asset = 'presentation-maker-vian-debian.tar.gz';
  expect((await run(['zip', '-q', join(release, denoAsset), 'deno'], process.env, release)).code).toBe(0);
  expect((await run(['tar', '-czf', join(release, asset), '-C', pkg, '.'], process.env)).code).toBe(0);
  for (const [file, sums] of [[asset, `${asset}.sha256`], [ytAsset, 'SHA2-256SUMS'], [denoAsset, `${denoAsset}.sha256sum`]]) {
    const digest = new Bun.CryptoHasher('sha256').update(await Bun.file(join(release, file)).arrayBuffer()).digest('hex');
    await writeFile(join(release, sums), `${digest}  ${file}\n`);
  }
  const env = { ...process.env, PATH: `${mocks}:${process.env.PATH}`, PRESENTATION_MAKER_INSTALL_DIR: target, PRESENTATION_MAKER_COMMAND_DIR: commands, XDG_CONFIG_HOME: config, FIXTURE_RELEASE_DIR: release, FIXTURE_SERVICE_LOG: join(root, 'service.log') };
  return { root, target, release, asset, saved, unit, unitContents, commands, env };
}

test('updates an existing installation, backs up private configuration, and supports the installed command', async () => {
  const f = await fixture();
  const result = await run(['bash', join(import.meta.dir, 'presentation-maker'), 'update'], f.env);
  expect(result.code, result.stderr).toBe(0);
  expect(await readFile(join(f.target, 'apps/backend/server.js'), 'utf8')).toBe('new release');
  for (const [file, contents] of Object.entries(f.saved)) expect(await readFile(join(f.target, file), 'utf8')).toBe(contents);
  expect(await readFile(f.unit, 'utf8')).toBe(f.unitContents);
  expect(await readFile(join(f.root, 'projects.db'), 'utf8')).toBe('existing-projects');
  const backups = await readdir(join(f.target, 'backups'));
  expect(backups.length).toBe(1);
  const backup = join(f.target, 'backups', backups[0]);
  expect((await stat(backup)).mode & 0o777).toBe(0o700);
  const extracted = join(f.root, 'restored');
  await mkdir(extracted);
  expect((await run(['tar', '-xzf', join(backup, 'bot.tar.gz'), '-C', extracted], f.env)).code).toBe(0);
  for (const [file, contents] of Object.entries(f.saved)) {
    expect(await readFile(file === '.env' ? join(backup, 'root.env') : join(extracted, file), 'utf8')).toBe(contents);
  }
  expect(await readFile(join(backup, 'presentation-maker-vian-backend.service'), 'utf8')).toBe(f.unitContents);
  const installed = await run([join(f.commands, 'presentation-maker'), 'update'], { ...f.env, PRESENTATION_MAKER_INSTALL_DIR: undefined });
  expect(installed.code, installed.stderr).toBe(0);
  expect((await readdir(join(f.target, 'backups'))).length).toBe(2);
});

test('rejects a corrupted release before touching the installation', async () => {
  const f = await fixture();
  await writeFile(join(f.release, f.asset), 'corrupted');
  const result = await run(['bash', join(import.meta.dir, 'presentation-maker'), 'update'], f.env);
  expect(result.code).not.toBe(0);
  expect(await readFile(join(f.target, 'apps/backend/server.js'), 'utf8')).toBe('old backend');
  expect(await Bun.file(join(f.root, 'service.log')).exists()).toBe(false);
  for (const [file, contents] of Object.entries(f.saved)) expect(await readFile(join(f.target, file), 'utf8')).toBe(contents);
});

test('keeps configuration and backup when dependency installation fails', async () => {
  const f = await fixture();
  const result = await run(['bash', join(import.meta.dir, 'presentation-maker'), 'update'], { ...f.env, FAIL_DENO: '1' });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('Copia de seguridad:');
  expect((await readdir(join(f.target, 'backups'))).length).toBe(1);
  for (const [file, contents] of Object.entries(f.saved)) expect(await readFile(join(f.target, file), 'utf8')).toBe(contents);
  expect(await readFile(join(f.target, 'apps/backend/server.js'), 'utf8')).toBe('old backend');
});

test('updates from a non-interactive shell when Bun is installed outside PATH', async () => {
  const f = await fixture();
  const bunInstall = join(f.root, 'bun-install');
  await mkdir(join(bunInstall, 'bin'), { recursive: true });
  const bun = join(bunInstall, 'bin/bun');
  await writeFile(bun, '#!/bin/sh\necho 1.4.2\n');
  await chmod(bun, 0o755);
  const result = await run(['bash', join(import.meta.dir, 'presentation-maker'), 'update'], {
    ...f.env, BUN_INSTALL: bunInstall, PATH: `${join(f.root, 'mocks')}:/usr/bin:/bin`,
  });
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain('Actualizado a v9.8.7');
  expect(await readFile(join(f.target, 'apps/backend/server.js'), 'utf8')).toBe('new release');
});

test('update reloads the running bot and migrates only its old attachment default', async () => {
  const f = await fixture();
  const manifest = join(f.target, 'bots/presentation-maker/vian.json');
  await writeFile(manifest, JSON.stringify({ id: 'fixture-bot', model: 'preserve', attachments: { maxFileBytes: 52428800, defaultTtlHours: 48 } }));
  const vian = join(f.root, 'mocks/vian');
  await writeFile(vian, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FIXTURE_SERVICE_LOG"\nif [ "$1" = status ]; then echo \'{"ok":true,"data":{"status":"running"}}\'; fi\n');
  await chmod(vian, 0o755);
  const result = await run(['bash', join(import.meta.dir, 'presentation-maker'), 'update'], f.env);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(await readFile(manifest, 'utf8'))).toEqual({ id: 'fixture-bot', model: 'preserve', attachments: { maxFileBytes: 262144000, defaultTtlHours: 48 } });
  expect(await readFile(join(f.root, 'service.log'), 'utf8')).toContain('restart fixture-bot --json');
});


test('refreshes managed layout rules while preserving custom instructions and local Telegram settings', async () => {
  const f = await fixture(true);
  const manifest = join(f.target,'bots/presentation-maker/vian.json');
  const config = {attachments:{maxFileBytes:262144000},gate:{telegram:{localApi:true,apiRoot:'http://127.0.0.1:8081',uploadTimeoutSeconds:1800}}};
  await writeFile(manifest,JSON.stringify(config));
  const instructions = join(f.target,'bots/presentation-maker/VIAN.md');
  await writeFile(instructions, 'Mis instrucciones personalizadas\n<!-- presentation-maker:managed-layout:start -->old<!-- presentation-maker:managed-layout:end -->\n');
  for (let i=0;i<2;i++) {
    const result = await run(['bash',join(import.meta.dir,'presentation-maker'),'update'],f.env);
    expect(result.code,result.stderr).toBe(0);
    const text=await readFile(instructions,'utf8');
    expect(text).toContain('Mis instrucciones personalizadas');
    expect(text).toContain('add_video_slides');
    expect(text.match(/managed-layout:start/g)?.length).toBe(1);
    expect(text).not.toContain('-->old<!--');
    expect(JSON.parse(await readFile(manifest,'utf8'))).toEqual(config);
  }
});
