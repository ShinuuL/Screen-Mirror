import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// A versão do cliente precisa ser idêntica à do scrcpy-server, senão ele recusa a conexão.
export const SCRCPY_VERSION = '5.0.1';
export const SCRCPY_SHA256 = '764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536';
export const SCRCPY_SERVER_URL =
  `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`;
export const SCRCPY_SERVER_LOCAL = join(ROOT, 'vendor', `scrcpy-server-v${SCRCPY_VERSION}`);
export const SCRCPY_SERVER_REMOTE = `/data/local/tmp/screen-mirror-server-${SCRCPY_VERSION}.jar`;

/** Pasta dos APKs que agentes podem instalar (o conteúdo não vai para o git). */
export const DIST_DIR = join(ROOT, 'dist');

export const HOST = process.env.SM_HOST ?? '127.0.0.1';
export const PORT = Number(process.env.SM_PORT ?? 7380);

/** Localiza o adb: ADB_PATH > ANDROID_HOME/ANDROID_SDK_ROOT > SDK padrão do usuário > PATH > vendor/. */
export function resolveAdbPath(): string {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const candidates = [
    process.env.ADB_PATH,
    process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, 'platform-tools', exe),
    process.env.ANDROID_SDK_ROOT && join(process.env.ANDROID_SDK_ROOT, 'platform-tools', exe),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', exe),
    process.env.HOME && join(process.env.HOME, 'Library', 'Android', 'sdk', 'platform-tools', exe),
    process.env.HOME && join(process.env.HOME, 'Android', 'Sdk', 'platform-tools', exe),
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  // PATH
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
  for (const d of dirs) if (d && existsSync(join(d, exe))) return join(d, exe);
  // Por último a cópia baixada pelo npm install: duas versões de adb disputam o mesmo servidor
  // (porta 5037), então o adb já existente na máquina tem prioridade.
  const bundled = join(ROOT, 'vendor', 'platform-tools', exe);
  if (existsSync(bundled)) return bundled;
  return 'adb';
}

export const PLATFORM_TOOLS_URL = `https://dl.google.com/android/repository/platform-tools-latest-${
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'
}.zip`;
