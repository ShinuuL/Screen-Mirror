// Baixa o scrcpy-server oficial (Apache 2.0) e confere o SHA-256 antes de aceitar o arquivo.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ROOT, PLATFORM_TOOLS_URL, resolveAdbPath, SCRCPY_SERVER_LOCAL, SCRCPY_SERVER_URL, SCRCPY_SHA256, SCRCPY_VERSION,
} from '../src/config.ts';

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

// adb: se a máquina não tiver (sem Android Studio/platform-tools), baixa o oficial do Google em vendor/.
if (resolveAdbPath() === 'adb') {
  console.log('adb não encontrado — baixando Android platform-tools oficial...');
  try {
    const res = await fetch(PLATFORM_TOOLS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const vendor = join(ROOT, 'vendor');
    mkdirSync(vendor, { recursive: true });
    const zip = join(vendor, 'platform-tools.zip');
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    try {
      // No Windows usa o bsdtar do sistema (lê zip); o GNU tar do Git no PATH trataria "C:" como host remoto.
      const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'unzip';
      if (process.platform === 'win32') execFileSync(tar, ['-xf', zip, '-C', vendor], { stdio: 'inherit' });
      else execFileSync(tar, ['-q', '-o', zip, '-d', vendor], { stdio: 'inherit' });
    } finally {
      rmSync(zip, { force: true });
    }
    console.log(`OK: ${resolveAdbPath()}`);
  } catch (err) {
    console.error(`Falha ao baixar o adb: ${(err as Error).message}. Instale o Android platform-tools ou defina ADB_PATH.`);
  }
}

if (existsSync(SCRCPY_SERVER_LOCAL) && sha256(readFileSync(SCRCPY_SERVER_LOCAL)) === SCRCPY_SHA256) {
  console.log(`scrcpy-server v${SCRCPY_VERSION} já presente.`);
  process.exit(0);
}

console.log(`Baixando scrcpy-server v${SCRCPY_VERSION}...`);
try {
  const res = await fetch(SCRCPY_SERVER_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = Buffer.from(await res.arrayBuffer());
  const hash = sha256(data);
  if (hash !== SCRCPY_SHA256) throw new Error(`SHA-256 divergente (esperado ${SCRCPY_SHA256}, obtido ${hash})`);
  mkdirSync(dirname(SCRCPY_SERVER_LOCAL), { recursive: true });
  const tmp = `${SCRCPY_SERVER_LOCAL}.part`;
  writeFileSync(tmp, data);
  renameSync(tmp, SCRCPY_SERVER_LOCAL);
  console.log(`OK: ${SCRCPY_SERVER_LOCAL} (${data.length} bytes)`);
} catch (err) {
  console.error(`Falha ao obter o scrcpy-server: ${(err as Error).message}`);
  console.error(`Baixe manualmente de ${SCRCPY_SERVER_URL} e salve em ${SCRCPY_SERVER_LOCAL}`);
  // Não derruba o npm install: screenshot, logcat, arquivos e MCP funcionam sem o espelhamento.
  process.exit(0);
}
