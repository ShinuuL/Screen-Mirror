// Ponto de entrada:  node src/cli.ts <serve [--open] [--port N] | mcp | doctor>
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HOST, PORT, ROOT, SCRCPY_SERVER_LOCAL, SCRCPY_VERSION } from './config.ts';

const [command = 'serve', ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(`--${name}`);
const option = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

switch (command) {
  case 'serve': {
    const { startServer } = await import('./server/http.ts');
    const port = Number(option('port') ?? PORT);
    const handle = await startServer(HOST, port).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Porta ${port} em uso — o painel provavelmente já está rodando em http://127.0.0.1:${port}`);
        if (flag('open')) openAppWindow(`http://127.0.0.1:${port}`);
        process.exit(1);
      }
      throw err;
    });
    console.log(`Screen Mirror rodando em ${handle.url}  (Ctrl+C para sair)`);
    if (flag('open')) openAppWindow(handle.url);
    const shutdown = async () => {
      await handle.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    break;
  }
  case 'mcp': {
    const { startMcpServer } = await import('./mcp/server.ts');
    await startMcpServer();
    break;
  }
  case 'doctor':
    await doctor();
    break;
  case 'pause':
  case 'resume':
  case 'policy': {
    const { loadPolicy, setPaused, POLICY_FILE, AUDIT_FILE } = await import('./core/policy.ts');
    const pol = command === 'policy' ? loadPolicy() : setPaused(command === 'pause');
    console.log(`Agentes: ${pol.paused ? 'PAUSADOS' : 'liberados'} · modo ${pol.mode} · shell ${pol.allowShell ? 'ligado' : 'desligado'} · ${pol.blockedApps.length} apps protegidos`);
    console.log(`Regras: ${POLICY_FILE}
Auditoria: ${AUDIT_FILE}`);
    break;
  }
  case 'mcp-install':
    mcpInstall();
    break;
  default:
    console.log('Uso: node src/cli.ts <serve [--open] [--port N] | mcp | mcp-install | policy | pause | resume | doctor>');
    process.exit(1);
}

/** Abre o painel numa janela própria (modo app do Edge/Chrome), sem barra de endereço. */
function openAppWindow(url: string): void {
  if (process.platform === 'win32') {
    const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean) as string[];
    const browsers = pf.flatMap((base) => [
      join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]);
    const exe = browsers.find(existsSync);
    if (exe) {
      spawn(exe, [`--app=${url}`, '--window-size=1400,900'], { detached: true, stdio: 'ignore' }).unref();
      return;
    }
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

/** Registra o servidor MCP no Claude Code (escopo do usuário) com os caminhos desta máquina. */
function mcpInstall(): void {
  const cli = join(ROOT, 'src', 'cli.ts');
  const config = { command: process.execPath, args: [cli, 'mcp'] };
  // Via shell porque "claude" é um .cmd no Windows; caminhos entre aspas aceitam espaços.
  spawnSync(`claude mcp remove --scope user screen-mirror`, { stdio: 'ignore', shell: true });
  const r = spawnSync(`claude mcp add --scope user screen-mirror -- "${process.execPath}" "${cli}" mcp`, { stdio: 'inherit', shell: true });
  if (r.status === 0) {
    console.log('Servidor MCP "screen-mirror" registrado no Claude Code para este usuário.');
    return;
  }
  console.log('Claude Code não encontrado ou o registro falhou. Para outros clientes MCP, use:\n');
  console.log(JSON.stringify({ mcpServers: { 'screen-mirror': config } }, null, 2));
}

async function doctor(): Promise<void> {
  const { ADB, run, listDevices } = await import('./core/adb.ts');
  const ok = (m: string) => console.log(`  [ok]  ${m}`);
  const bad = (m: string) => console.log(`  [!!]  ${m}`);
  console.log('Screen Mirror — diagnóstico\n');

  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major! > 22 || (major === 22 && minor! >= 18)) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node} — requer 22.18+ (execução nativa de TypeScript)`);

  try {
    const v = (await run(['version'], { timeoutMs: 10000 })).stdout.toString().split('\n')[1]?.trim();
    ok(`adb: ${ADB} (${v})`);
  } catch (err) {
    bad(`adb não encontrado: ${(err as Error).message}`);
  }

  if (existsSync(SCRCPY_SERVER_LOCAL)) ok(`scrcpy-server v${SCRCPY_VERSION}`);
  else bad(`scrcpy-server ausente — rode "npm run setup" (sem ele não há espelhamento ao vivo)`);

  try {
    await import('sharp');
    ok('sharp (redução de screenshots para agentes)');
  } catch {
    bad('sharp indisponível — screenshots irão em resolução nativa');
  }

  try {
    const devices = await listDevices();
    if (!devices.length) bad('Nenhum celular conectado. Ative Opções do desenvolvedor > Depuração USB e conecte o cabo.');
    for (const d of devices) (d.state === 'device' ? ok : bad)(`${d.serial} ${d.model ?? ''} — ${d.state}`);
  } catch (err) {
    bad(`Falha ao listar aparelhos: ${(err as Error).message}`);
  }
}
