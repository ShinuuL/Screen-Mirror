// Dependências externas obtidas sob demanda: adb (Google) e scrcpy-server (Genymobile, Apache 2.0).
// Usado pelo "npm install" e pelo executável na primeira execução.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, PLATFORM_TOOLS_URL, resolveAdbPath, SCRCPY_SERVER_LOCAL, SCRCPY_SERVER_URL, SCRCPY_SHA256, SCRCPY_VERSION } from '../config.ts';

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** Extrai .zip/.tar.* com o tar do sistema (no Windows, o bsdtar do System32 — o GNU tar do Git não lê zip). */
export function extract(archive: string, dest: string, members: string[] = []): void {
  mkdirSync(dest, { recursive: true });
  if (process.platform === 'win32') {
    execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', archive, '-C', dest, ...members], { stdio: 'inherit' });
  } else if (archive.endsWith('.zip')) {
    execFileSync('unzip', ['-q', '-o', archive, ...members, '-d', dest], { stdio: 'inherit' });
  } else {
    execFileSync('tar', ['-xf', archive, '-C', dest, ...members], { stdio: 'inherit' });
  }
}

/** Baixa o Android platform-tools oficial para vendor/ se a máquina não tiver adb. */
export async function ensureAdb(log: (m: string) => void = console.log): Promise<void> {
  if (resolveAdbPath() !== 'adb') return;
  log('adb não encontrado — baixando o Android platform-tools oficial do Google...');
  const res = await fetch(PLATFORM_TOOLS_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar ${PLATFORM_TOOLS_URL}`);
  const vendor = join(ROOT, 'vendor');
  mkdirSync(vendor, { recursive: true });
  const zip = join(vendor, 'platform-tools.zip');
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  try {
    extract(zip, vendor);
  } finally {
    rmSync(zip, { force: true });
  }
  log(`adb instalado: ${resolveAdbPath()}`);
}

/** Baixa o scrcpy-server e confere o SHA-256. */
export async function ensureScrcpyServer(log: (m: string) => void = console.log): Promise<void> {
  if (existsSync(SCRCPY_SERVER_LOCAL) && sha256(readFileSync(SCRCPY_SERVER_LOCAL)) === SCRCPY_SHA256) return;
  log(`Baixando scrcpy-server v${SCRCPY_VERSION}...`);
  const res = await fetch(SCRCPY_SERVER_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = Buffer.from(await res.arrayBuffer());
  const hash = sha256(data);
  if (hash !== SCRCPY_SHA256) throw new Error(`SHA-256 divergente (esperado ${SCRCPY_SHA256}, obtido ${hash})`);
  mkdirSync(dirname(SCRCPY_SERVER_LOCAL), { recursive: true });
  const tmp = `${SCRCPY_SERVER_LOCAL}.part`;
  writeFileSync(tmp, data);
  renameSync(tmp, SCRCPY_SERVER_LOCAL);
  log(`scrcpy-server pronto (${data.length} bytes).`);
}
