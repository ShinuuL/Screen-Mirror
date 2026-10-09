// Servidor MCP (stdio) para agentes de IA enxergarem e operarem o celular.
// IMPORTANTE: stdout é o canal do protocolo — logs vão para stderr.
import { resolve as resolvePath, basename } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { listDevices, resolveSerial, run } from '../core/adb.ts';
import * as dev from '../core/device.ts';
import { queryLogcat, clearLogcat, formatEntry, LEVELS } from '../core/logcat.ts';
import { pasteText } from '../core/scrcpy.ts';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type Result = { content: Content[]; isError?: boolean };

const text = (t: string): Result => ({ content: [{ type: 'text', text: t }] });
const MAX_TEXT = 80_000;
const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n… (cortado: ${s.length - MAX_TEXT} caracteres a mais)` : s);

/** Converte exceções em resultado de erro legível para o agente, em vez de derrubar a chamada. */
function safe<A>(fn: (args: A) => Promise<Result>): (args: A) => Promise<Result> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      return { content: [{ type: 'text', text: `Erro: ${(err as Error).message}` }], isError: true };
    }
  };
}

const serialArg = z.string().optional().describe('Serial do aparelho (veja list_devices). Opcional se houver só um conectado.');
const coord = z.number().describe('Coordenada em pixels do aparelho');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startMcpServer(): Promise<void> {
  const server = new McpServer(
    { name: 'screen-mirror', version: '0.1.0' },
    {
      instructions: [
        'Controle de celulares Android via ADB (depuração USB).',
        'Fluxo recomendado: ui_tree (barato, dá coordenadas exatas) ou screenshot (visual) -> tap_element/tap/swipe/type_text -> screenshot para conferir.',
        'Todas as coordenadas são em pixels do aparelho. A ferramenta screenshot informa a escala da imagem.',
        'Para depurar apps: logcat com package e level=E, ou buffer=crash para crashes.',
      ].join('\n'),
    },
  );

  server.registerTool(
    'list_devices',
    { title: 'Listar aparelhos', description: 'Lista celulares conectados via ADB e o estado de cada um (device, unauthorized, offline).', inputSchema: {} },
    safe(async () => {
      const devices = await listDevices();
      if (!devices.length) return text('Nenhum aparelho conectado. Conecte via USB com a depuração USB ativada.');
      return text(devices.map((d) => `${d.serial}\t${d.state}\t${d.model ?? ''}\t${d.connection}`).join('\n'));
    }),
  );

  server.registerTool(
    'device_info',
    { title: 'Informações do aparelho', description: 'Modelo, versão do Android, resolução, densidade, bateria e app em primeiro plano.', inputSchema: { serial: serialArg } },
    safe(async ({ serial }) => {
      const s = await resolveSerial(serial);
      const [info, app] = await Promise.all([dev.getInfo(s), dev.currentApp(s).catch(() => null)]);
      return text(JSON.stringify({ ...info, foreground: app ? `${app.package}/${app.activity}` : null }, null, 2));
    }),
  );

  server.registerTool(
    'screenshot',
    {
      title: 'Capturar tela',
      description:
        'Captura a tela atual. A imagem pode vir reduzida; o texto informa a resolução real e o fator para converter coordenadas da imagem em pixels do aparelho.',
      inputSchema: {
        serial: serialArg,
        max_size: z.number().int().min(320).max(4096).optional().describe('Maior lado da imagem em px (padrão 1600).'),
        format: z.enum(['jpeg', 'png']).optional().describe('jpeg (padrão, menor) ou png (sem perdas).'),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ serial, max_size, format }) => {
      const s = await resolveSerial(serial);
      const img = await dev.screenshotForAgent(s, { maxSize: max_size, format });
      const factor = 1 / img.scale;
      const note =
        img.scale === 1
          ? `Tela ${img.deviceWidth}x${img.deviceHeight}px. Coordenadas da imagem = coordenadas do aparelho.`
          : `Tela ${img.deviceWidth}x${img.deviceHeight}px; imagem ${img.width}x${img.height}px. Para tocar, multiplique as coordenadas da imagem por ${factor.toFixed(4)}.`;
      return { content: [{ type: 'image', data: img.data.toString('base64'), mimeType: img.mimeType }, { type: 'text', text: note }] };
    }),
  );

  server.registerTool(
    'ui_tree',
    {
      title: 'Árvore de interface',
      description:
        'Lista os elementos da tela (texto, content-desc, resource-id, se é clicável, centro e limites em px). Mais preciso e barato que screenshot para localizar botões e campos.',
      inputSchema: {
        serial: serialArg,
        all: z.boolean().optional().describe('Inclui contêineres sem texto/interação (padrão false).'),
        raw_xml: z.boolean().optional().describe('Devolve o XML bruto do uiautomator.'),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ serial, all, raw_xml }) => {
      const s = await resolveSerial(serial);
      if (raw_xml) return text(clip(await dev.dumpUiXml(s)));
      const nodes = await dev.dumpUi(s);
      const list = all ? nodes : dev.interestingNodes(nodes);
      const pkg = nodes.find((n) => n.pkg)?.pkg ?? '?';
      return text(clip(`App: ${pkg} — ${list.length} elementos\n${dev.formatUiNodes(list)}`));
    }),
  );

  server.registerTool(
    'tap',
    { title: 'Tocar', description: 'Toca em um ponto da tela (pixels do aparelho).', inputSchema: { serial: serialArg, x: coord, y: coord } },
    safe(async ({ serial, x, y }) => {
      await dev.tap(await resolveSerial(serial), x, y);
      return text(`Toque em (${Math.round(x)}, ${Math.round(y)}).`);
    }),
  );

  const queryShape = {
    text: z.string().optional().describe('Texto visível ou content-desc (sem diferenciar maiúsculas/acentos, por trecho).'),
    id: z.string().optional().describe('resource-id completo ou só o final (ex.: "btn_login").'),
    desc: z.string().optional().describe('content-desc (acessibilidade).'),
    exact: z.boolean().optional().describe('Exige correspondência exata.'),
  };

  server.registerTool(
    'tap_element',
    {
      title: 'Tocar em elemento',
      description: 'Localiza um elemento pela árvore de UI (texto, id ou descrição) e toca no centro dele.',
      inputSchema: { serial: serialArg, ...queryShape, index: z.number().int().min(0).optional().describe('Qual ocorrência usar se houver várias (padrão 0).'), long_press: z.boolean().optional() },
    },
    safe(async ({ serial, text: t, id, desc, exact, index, long_press }) => {
      if (t === undefined && id === undefined && desc === undefined) throw new Error('Informe text, id ou desc.');
      const s = await resolveSerial(serial);
      const matches = dev.findNodes(dev.interestingNodes(await dev.dumpUi(s)), { text: t, id, desc, exact });
      if (!matches.length) throw new Error('Nenhum elemento corresponde. Use ui_tree para ver o que está na tela.');
      const target = matches[index ?? 0];
      if (!target) throw new Error(`Só há ${matches.length} correspondência(s).`);
      const [x, y] = target.center;
      if (long_press) await dev.longPress(s, x, y);
      else await dev.tap(s, x, y);
      const others = matches.length > 1 ? `\nOutras correspondências (${matches.length - 1}):\n${dev.formatUiNodes(matches.filter((m) => m !== target).slice(0, 10))}` : '';
      return text(`${long_press ? 'Toque longo' : 'Toque'} em ${dev.formatUiNodes([target]).trim()}${others}`);
    }),
  );

  server.registerTool(
    'wait_for',
    {
      title: 'Aguardar elemento',
      description: 'Espera um elemento aparecer (ou sumir, com gone=true) na tela. Útil após abrir apps, carregar telas ou enviar formulários.',
      inputSchema: { serial: serialArg, ...queryShape, gone: z.boolean().optional(), timeout_ms: z.number().int().min(500).max(120000).optional().describe('Padrão 10000.') },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ serial, text: t, id, desc, exact, gone, timeout_ms }) => {
      if (t === undefined && id === undefined && desc === undefined) throw new Error('Informe text, id ou desc.');
      const s = await resolveSerial(serial);
      const deadline = Date.now() + (timeout_ms ?? 10000);
      let lastErr = '';
      while (Date.now() < deadline) {
        try {
          const matches = dev.findNodes(dev.interestingNodes(await dev.dumpUi(s)), { text: t, id, desc, exact });
          if (gone ? !matches.length : matches.length) {
            return text(gone ? 'O elemento não está mais na tela.' : `Encontrado:\n${dev.formatUiNodes(matches.slice(0, 10))}`);
          }
        } catch (err) {
          lastErr = (err as Error).message;
        }
        await sleep(600);
      }
      throw new Error(`Tempo esgotado aguardando o elemento ${gone ? 'sumir' : 'aparecer'}.${lastErr ? ` Último erro: ${lastErr}` : ''}`);
    }),
  );

  server.registerTool(
    'swipe',
    {
      title: 'Deslizar',
      description: 'Arrasta de (x1,y1) até (x2,y2). Para rolar a lista para baixo, deslize de baixo para cima.',
      inputSchema: { serial: serialArg, x1: coord, y1: coord, x2: coord, y2: coord, duration_ms: z.number().int().min(10).max(10000).optional().describe('Padrão 300.') },
    },
    safe(async ({ serial, x1, y1, x2, y2, duration_ms }) => {
      await dev.swipe(await resolveSerial(serial), x1, y1, x2, y2, duration_ms ?? 300);
      return text(`Deslizou de (${x1}, ${y1}) até (${x2}, ${y2}).`);
    }),
  );

  server.registerTool(
    'long_press',
    { title: 'Toque longo', description: 'Pressiona e segura um ponto.', inputSchema: { serial: serialArg, x: coord, y: coord, duration_ms: z.number().int().min(100).max(10000).optional() } },
    safe(async ({ serial, x, y, duration_ms }) => {
      await dev.longPress(await resolveSerial(serial), x, y, duration_ms ?? 800);
      return text(`Toque longo em (${x}, ${y}).`);
    }),
  );

  server.registerTool(
    'type_text',
    {
      title: 'Digitar texto',
      description:
        'Digita no campo focado (toque no campo antes). Aceita acentos e emoji. submit=true pressiona Enter ao final. ' +
        'method=paste (padrão) cola o texto de uma vez e preserva a área de transferência; method=keys simula teclas (só ASCII; use se o campo bloquear colagem).',
      inputSchema: { serial: serialArg, text: z.string().min(1), submit: z.boolean().optional(), method: z.enum(['paste', 'keys']).optional() },
    },
    safe(async ({ serial, text: t, submit, method }) => {
      const s = await resolveSerial(serial);
      if (method === 'keys') await dev.inputTextAscii(s, t);
      else await pasteText(s, t);
      if (submit) await dev.pressKey(s, 'ENTER');
      return text(`Digitado (${t.length} caracteres)${submit ? ' + Enter' : ''}.`);
    }),
  );

  server.registerTool(
    'press_key',
    {
      title: 'Pressionar tecla',
      description: `Tecla do sistema por nome (${['HOME', 'BACK', 'APP_SWITCH', 'ENTER', 'DEL', 'POWER', 'VOLUME_UP', 'VOLUME_DOWN', 'TAB', 'ESCAPE', 'WAKEUP', 'SLEEP', 'MENU'].join(', ')}...) ou keycode numérico.`,
      inputSchema: { serial: serialArg, key: z.union([z.string(), z.number().int()]), long_press: z.boolean().optional() },
    },
    safe(async ({ serial, key, long_press }) => {
      const code = await dev.pressKey(await resolveSerial(serial), key, long_press);
      return text(`Tecla ${key} (keycode ${code}).`);
    }),
  );

  server.registerTool(
    'open_app',
    { title: 'Abrir app', description: 'Abre um app pelo nome do pacote (veja list_apps).', inputSchema: { serial: serialArg, package: z.string() } },
    safe(async ({ serial, package: pkg }) => {
      await dev.startApp(await resolveSerial(serial), pkg);
      return text(`App ${pkg} aberto.`);
    }),
  );

  server.registerTool(
    'stop_app',
    { title: 'Encerrar app', description: 'Força o encerramento de um app (am force-stop).', inputSchema: { serial: serialArg, package: z.string() }, annotations: { destructiveHint: true } },
    safe(async ({ serial, package: pkg }) => {
      await dev.stopApp(await resolveSerial(serial), pkg);
      return text(`App ${pkg} encerrado.`);
    }),
  );

  server.registerTool(
    'list_apps',
    {
      title: 'Listar apps',
      description: 'Lista pacotes instalados (por padrão só os instalados pelo usuário).',
      inputSchema: { serial: serialArg, filter: z.string().optional(), include_system: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ serial, filter, include_system }) => {
      const pkgs = await dev.listPackages(await resolveSerial(serial), { filter, includeSystem: include_system });
      return text(pkgs.length ? pkgs.join('\n') : 'Nenhum pacote encontrado.');
    }),
  );

  server.registerTool(
    'logcat',
    {
      title: 'Ler logcat',
      description:
        'Lê os logs do Android (logcat -d). Filtre por pacote (usa o PID atual do app), nível mínimo, tag ou regex. buffer=crash mostra só crashes.',
      inputSchema: {
        serial: serialArg,
        lines: z.number().int().min(1).max(5000).optional().describe('Máximo de linhas (padrão 200).'),
        level: z.enum(LEVELS).optional().describe('Nível mínimo: V, D, I, W, E, F.'),
        package: z.string().optional(),
        tag: z.string().optional(),
        grep: z.string().optional().describe('Regex sem diferenciar maiúsculas, aplicada a "tag: mensagem".'),
        buffer: z.enum(['main', 'system', 'crash', 'events', 'radio', 'all', 'default']).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ serial, lines, level, package: pkg, tag, grep, buffer }) => {
      const r = await queryLogcat(await resolveSerial(serial), { lines, minLevel: level, pkg, tag, grep, buffer });
      const body = r.entries.map(formatEntry).join('\n') || '(nenhuma entrada)';
      return text(clip((r.note ? `${r.note}\n` : '') + body));
    }),
  );

  server.registerTool(
    'clear_logcat',
    { title: 'Limpar logcat', description: 'Limpa os buffers do logcat — útil antes de reproduzir um bug.', inputSchema: { serial: serialArg } },
    safe(async ({ serial }) => {
      await clearLogcat(await resolveSerial(serial));
      return text('Logcat limpo.');
    }),
  );

  server.registerTool(
    'list_files',
    {
      title: 'Listar arquivos',
      description: 'Lista uma pasta do aparelho. Armazenamento do usuário: /sdcard (Download, DCIM, Documents...).',
      inputSchema: { serial: serialArg, path: z.string().optional().describe('Padrão /sdcard.') },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ serial, path }) => {
      const dir = path ?? '/sdcard';
      const entries = await dev.listDir(await resolveSerial(serial), dir);
      const fmt = (e: dev.FileEntry) =>
        `${e.type === 'dir' ? 'd' : '-'} ${String(e.size).padStart(12)} ${new Date(e.mtime * 1000).toISOString().slice(0, 16).replace('T', ' ')} ${e.name}${e.type === 'dir' ? '/' : ''}`;
      return text(clip(`${dir} (${entries.length} itens)\n${entries.map(fmt).join('\n')}`));
    }),
  );

  server.registerTool(
    'pull_file',
    {
      title: 'Copiar do celular para o PC',
      description: 'Copia um arquivo ou pasta do aparelho para o computador.',
      inputSchema: { serial: serialArg, remote: z.string(), local: z.string().optional().describe('Destino no PC (padrão: pasta atual).') },
    },
    safe(async ({ serial, remote, local }) => {
      const dest = resolvePath(local ?? basename(remote));
      const r = await dev.pull(await resolveSerial(serial), remote, dest);
      return text(`${r}\nSalvo em ${dest}`);
    }),
  );

  server.registerTool(
    'push_file',
    {
      title: 'Copiar do PC para o celular',
      description: 'Envia um arquivo ou pasta do computador para o aparelho.',
      inputSchema: { serial: serialArg, local: z.string(), remote: z.string().optional().describe('Destino (padrão /sdcard/Download/<nome>).') },
    },
    safe(async ({ serial, local, remote }) => {
      const src = resolvePath(local);
      if (!existsSync(src)) throw new Error(`Arquivo local não encontrado: ${src}`);
      const dest = remote ?? `/sdcard/Download/${basename(src)}`;
      return text(`${await dev.push(await resolveSerial(serial), src, dest)}\nEnviado para ${dest}`);
    }),
  );

  server.registerTool(
    'install_apk',
    { title: 'Instalar APK', description: 'Instala (ou atualiza) um APK do computador no aparelho.', inputSchema: { serial: serialArg, path: z.string() } },
    safe(async ({ serial, path }) => {
      const src = resolvePath(path);
      if (!existsSync(src) || !statSync(src).isFile()) throw new Error(`APK não encontrado: ${src}`);
      return text(await dev.installApk(src, await resolveSerial(serial)));
    }),
  );

  server.registerTool(
    'shell',
    {
      title: 'Comando shell',
      description: 'Executa um comando no shell do Android (usuário "shell", sem root). Ex.: "dumpsys battery", "pm path com.app", "am start -n ...".',
      inputSchema: { serial: serialArg, command: z.string().min(1), timeout_ms: z.number().int().min(1000).max(600000).optional().describe('Padrão 30000.') },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    safe(async ({ serial, command, timeout_ms }) => {
      const r = await run(['shell', command], { serial: await resolveSerial(serial), timeoutMs: timeout_ms ?? 30000, allowFailure: true });
      const out = r.stdout.toString('utf8').replace(/\r\n/g, '\n').trimEnd();
      return { content: [{ type: 'text', text: clip(`${out}${r.stderr ? `\n[stderr] ${r.stderr}` : ''}\n[código de saída: ${r.code}]`) }], isError: r.code !== 0 };
    }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('screen-mirror MCP pronto (stdio).\n');
}
