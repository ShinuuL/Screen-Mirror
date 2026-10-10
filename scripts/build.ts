// Gera executáveis únicos (Node SEA) em dist/:  node scripts/build.ts [win-x64] [linux-x64]
//
// Cada pacote: binário + web/ + vendor/scrcpy-server + node_modules/sharp da plataforma + apks/ + LEIA-ME.
// O adb NÃO vai no pacote (a licença do Android SDK não permite redistribuir): o executável baixa
// do Google na primeira execução, se a máquina não tiver.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { ROOT, SCRCPY_SERVER_LOCAL, SCRCPY_VERSION } from '../src/config.ts';
import { ensureScrcpyServer, extract } from '../src/core/setup.ts';

type Target = 'win-x64' | 'linux-x64';
const ALL: Target[] = ['win-x64', 'linux-x64'];
const targets = (process.argv.slice(2).filter((a) => ALL.includes(a as Target)) as Target[]).concat();
if (!targets.length) targets.push(...ALL);

const NODE_VERSION = process.versions.node; // o blob SEA exige a mesma versão do binário alvo
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string; dependencies: Record<string, string> };
const CACHE = join(ROOT, '.build-cache');
const DIST = join(ROOT, 'dist');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const step = (m: string) => console.log(`\n▸ ${m}`);

async function download(url: string, file: string): Promise<Buffer> {
  if (existsSync(file)) return readFileSync(file);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const data = Buffer.from(await res.arrayBuffer());
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, data);
  return data;
}

/** Binário oficial do Node para o alvo, conferido contra o SHASUMS256.txt publicado. */
async function nodeBinary(target: Target): Promise<string> {
  const name = target === 'win-x64' ? `node-v${NODE_VERSION}-win-x64.zip` : `node-v${NODE_VERSION}-linux-x64.tar.xz`;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const dir = join(CACHE, 'node', target);
  const bin = join(dir, target === 'win-x64' ? `node-v${NODE_VERSION}-win-x64/node.exe` : `node-v${NODE_VERSION}-linux-x64/bin/node`);
  if (existsSync(bin)) return bin;
  const sums = (await download(`${base}/SHASUMS256.txt`, join(CACHE, 'node', `SHASUMS256-${NODE_VERSION}.txt`))).toString();
  const expected = sums.split('\n').find((l) => l.endsWith(`  ${name}`))?.split(/\s+/)[0];
  const archive = join(dir, name);
  const data = await download(`${base}/${name}`, archive);
  if (!expected || sha256(data) !== expected) {
    rmSync(archive, { force: true });
    throw new Error(`SHA-256 do ${name} não confere com o SHASUMS256.txt oficial`);
  }
  // Só o binário: o pacote Linux tem symlinks (bin/npm) que o tar do Windows não cria.
  extract(archive, dir, [relative(dir, bin).split(sep).join('/')]);
  return bin;
}

/** sharp + binários nativos da plataforma alvo (npm com --os/--cpu). */
function sharpModules(target: Target): string {
  const dir = join(CACHE, 'sharp', target);
  const nm = join(dir, 'node_modules');
  if (existsSync(join(nm, 'sharp'))) return nm;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"private":true}');
  const os = target === 'win-x64' ? 'win32' : 'linux';
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const version = pkg.dependencies.sharp!.replace(/^[\^~]/, '');
  // sharp ≥ 0.33 usa binários pré-compilados (@img/*): nenhum script de instalação é necessário.
  const args = ['install', '--no-audit', '--no-fund', '--omit=dev', '--ignore-scripts', `--os=${os}`, '--cpu=x64', ...(os === 'linux' ? ['--libc=glibc'] : []), `sharp@${version}`];
  // Sem as variáveis npm_config_* herdadas do "npm run build" (elas valem para este projeto, não para o cache).
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toLowerCase().startsWith('npm_')));
  execFileSync(npm, args, { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32', env });
  return nm;
}

async function bundle(): Promise<string> {
  const out = join(CACHE, 'bundle.mjs');
  await build({
    entryPoints: [join(ROOT, 'src', 'cli.ts')],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: `node${NODE_VERSION.split('.')[0]}`,
    // sharp tem binários nativos: fica em node_modules/ ao lado do executável.
    external: ['sharp'],
    // Dependências CommonJS (ws, MCP SDK) usam require(); no ESM empacotado ele precisa existir.
    banner: { js: "import { createRequire as __smRequire } from 'node:module'; const require = __smRequire(import.meta.url);" },
    legalComments: 'none',
    logLevel: 'warning',
  });
  return out;
}

// ---------------------------------------------------------------- arquivos compactados

/** tar.gz com permissões Unix corretas (executáveis 0755), independente do sistema que gera o build. */
function writeTarGz(srcDir: string, rootName: string, outFile: string, executables: Set<string>): void {
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, mode: number, type: '0' | '5') => {
    const h = Buffer.alloc(512);
    let prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const i = name.lastIndexOf('/', 154);
      prefix = name.slice(0, i);
      name = name.slice(i + 1);
    }
    h.write(name, 0, 100);
    h.write(mode.toString(8).padStart(7, '0'), 100);
    h.write('0000000', 108);
    h.write('0000000', 116);
    h.write(size.toString(8).padStart(11, '0'), 124);
    h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0'), 136);
    h.write('        ', 148);
    h.write(type, 156);
    h.write('ustar\u000000', 257);
    h.write(prefix, 345, 155);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\u0000 ', 148);
    return h;
  };
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, e.name);
      const rel = `${rootName}/${relative(srcDir, full).split(sep).join('/')}`;
      if (e.isDirectory()) {
        blocks.push(header(`${rel}/`, 0, 0o755, '5'));
        walk(full);
      } else if (e.isFile()) {
        const data = readFileSync(full);
        blocks.push(header(rel, data.length, executables.has(relative(srcDir, full).split(sep).join('/')) ? 0o755 : 0o644, '0'));
        blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
      }
    }
  };
  blocks.push(header(`${rootName}/`, 0, 0o755, '5'));
  walk(srcDir);
  blocks.push(Buffer.alloc(1024));
  writeFileSync(outFile, gzipSync(Buffer.concat(blocks), { level: 9 }));
}

function writeZip(srcDir: string, outFile: string): void {
  rmSync(outFile, { force: true });
  if (process.platform === 'win32') {
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-a', '-c', '-f', outFile, '-C', join(srcDir, '..'), basename(srcDir)], { stdio: 'inherit' });
  } else {
    execFileSync('zip', ['-q', '-r', outFile, basename(srcDir)], { cwd: join(srcDir, '..'), stdio: 'inherit' });
  }
}

// ---------------------------------------------------------------- build

const LEIA_ME = (target: Target, exe: string) => `Screen Mirror ${pkg.version} (${target})

Espelhamento e controle de celulares Android via depuração USB, com painel local e servidor MCP para agentes de IA.

USO
  ${target === 'win-x64' ? `Dois cliques em ${exe}` : `./${exe}`}       abre o painel (http://127.0.0.1:7380)
  ${exe} mcp               servidor MCP (stdio) para agentes de IA
  ${exe} mcp-install       registra o MCP no Claude Code deste usuário
  ${exe} doctor            diagnóstico (adb, celular conectado)
  ${exe} pause | resume    pausa/libera os agentes de IA
  ${exe} policy            mostra as regras dos agentes (~/.screen-mirror/policy.json)

PRIMEIRA EXECUÇÃO
  Se a máquina não tiver o adb, ele é baixado do Google (Android platform-tools) para vendor/platform-tools.
  No celular: Opções do desenvolvedor > Depuração USB, conecte o cabo e aceite o aviso.${
  target === 'linux-x64'
    ? `
  Linux: se o celular não aparecer, adicione seu usuário ao grupo plugdev e instale as regras udev do Android
  (pacote "android-sdk-platform-tools-common" ou "android-udev-rules"). Diálogo de confirmação usa o zenity.`
    : `
  Windows: alguns celulares exigem o driver USB do fabricante. O executável não é assinado; o SmartScreen
  pode exibir "editor desconhecido" na primeira execução.`
}

PASTAS
  web/      painel            vendor/   scrcpy-server e adb      apks/   APKs que agentes podem instalar
  node_modules/sharp          redução de capturas para agentes (opcional)

LICENÇAS DE TERCEIROS
  scrcpy-server ${SCRCPY_VERSION} — Copyright (C) Genymobile, Romain Vimont. Apache License 2.0.
    https://github.com/Genymobile/scrcpy
  Node.js ${NODE_VERSION} — MIT. sharp/libvips — Apache 2.0 / LGPL-3.0.
`;

async function buildTarget(target: Target, bundlePath: string): Promise<string> {
  step(`${target}: binário do Node ${NODE_VERSION}`);
  const nodeBin = await nodeBinary(target);
  const name = `screen-mirror-${pkg.version}-${target}`;
  const out = join(DIST, name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const exe = target === 'win-x64' ? 'ScreenMirror.exe' : 'screen-mirror';

  step(`${target}: executável único`);
  const seaConfig = join(CACHE, `sea-${target}.json`);
  writeFileSync(
    seaConfig,
    JSON.stringify({
      main: bundlePath,
      mainFormat: 'module',
      executable: nodeBin,
      output: join(out, exe),
      disableExperimentalSEAWarning: true,
      // Código/snapshot pré-compilados só funcionam na plataforma em que foram gerados.
      useCodeCache: false,
      useSnapshot: false,
    }),
  );
  execFileSync(process.execPath, ['--build-sea', seaConfig], { stdio: 'inherit' });

  step(`${target}: recursos`);
  cpSync(join(ROOT, 'web'), join(out, 'web'), { recursive: true });
  mkdirSync(join(out, 'vendor'), { recursive: true });
  cpSync(SCRCPY_SERVER_LOCAL, join(out, 'vendor', basename(SCRCPY_SERVER_LOCAL)));
  mkdirSync(join(out, 'apks'), { recursive: true });
  cpSync(join(ROOT, 'apks', 'LEIA-ME.txt'), join(out, 'apks', 'LEIA-ME.txt'));
  cpSync(sharpModules(target), join(out, 'node_modules'), { recursive: true });
  writeFileSync(join(out, 'LEIA-ME.txt'), LEIA_ME(target, exe).replace(/\n/g, target === 'win-x64' ? '\r\n' : '\n'));

  step(`${target}: compactando`);
  if (target === 'win-x64') {
    const zip = join(DIST, `${name}.zip`);
    writeZip(out, zip);
    return zip;
  }
  const tgz = join(DIST, `${name}.tar.gz`);
  writeTarGz(out, name, tgz, new Set([exe]));
  return tgz;
}

step('scrcpy-server');
await ensureScrcpyServer();
step('empacotando o código (esbuild)');
const bundlePath = await bundle();
const outputs: string[] = [];
for (const t of targets) outputs.push(await buildTarget(t, bundlePath));

console.log('\nPronto:');
for (const f of outputs) console.log(`  ${relative(ROOT, f)}  (${(statSync(f).size / 1048576).toFixed(1)} MB)  sha256 ${sha256(readFileSync(f))}`);
