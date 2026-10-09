// Servidor local: painel web, API REST e WebSockets (dispositivos, espelhamento, logcat).
// Escuta apenas em 127.0.0.1 e valida Host/Origin para impedir que sites externos controlem o celular.
import http from 'node:http';
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, normalize, basename, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { ROOT } from '../config.ts';
import { DeviceTracker, resolveSerial, spawnAdb, shell, q, AdbError } from '../core/adb.ts';
import * as dev from '../core/device.ts';
import { queryLogcat, clearLogcat, formatEntry, LogcatStream, type Level, type LogEntry } from '../core/logcat.ts';
import { pasteText } from '../core/scrcpy.ts';
import { MirrorHub } from './mirror.ts';
import { loadPolicy, setPaused, POLICY_FILE } from '../core/policy.ts';

const WEB_DIR = join(ROOT, 'web');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Handler = (ctx: { req: http.IncomingMessage; res: http.ServerResponse; url: URL; serial: () => Promise<string> }) => Promise<unknown>;

export interface ServerHandle {
  url: string;
  close(): Promise<void>;
}

export async function startServer(host: string, port: number): Promise<ServerHandle> {
  const tracker = new DeviceTracker();
  await tracker.start();
  const hub = new MirrorHub();

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readJson = async (req: http.IncomingMessage) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 1024 * 1024) throw new HttpError(413, 'Corpo muito grande.');
      chunks.push(c as Buffer);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  };

  /** Grava o corpo da requisição num arquivo temporário (upload de arquivo/APK). */
  const bodyToTemp = async (req: http.IncomingMessage, name: string) => {
    const tmp = join(tmpdir(), `screen-mirror-${randomUUID()}-${safeName(name)}`);
    await pipeline(req, createWriteStream(tmp));
    return tmp;
  };

  const routes: Record<string, Handler> = {
    'GET /api/meta': async ({ res }) => json(res, 200, { root: ROOT, sep, version: '0.1.0' }),

    'GET /api/agents': async ({ res }) => {
      const p = loadPolicy();
      json(res, 200, { paused: p.paused, mode: p.mode, file: POLICY_FILE });
    },

    'POST /api/agents/pause': async ({ res, url }) => {
      const p = setPaused(url.searchParams.get('on') !== '0');
      json(res, 200, { paused: p.paused, mode: p.mode, file: POLICY_FILE });
    },

    'GET /api/devices': async ({ res }) => json(res, 200, { devices: tracker.devices, mirroring: hub.active() }),

    'GET /api/info': async ({ res, serial }) => json(res, 200, await dev.getInfo(await serial())),

    'GET /api/screenshot': async ({ res, url, serial }) => {
      const s = await serial();
      const maxSize = Number(url.searchParams.get('maxSize') ?? 0);
      if (maxSize > 0) {
        const fmt = url.searchParams.get('format') === 'png' ? 'png' : 'jpeg';
        const img = await dev.screenshotForAgent(s, { maxSize, format: fmt });
        res.writeHead(200, { 'content-type': img.mimeType, 'x-device-size': `${img.deviceWidth}x${img.deviceHeight}`, 'x-scale': String(img.scale) });
        res.end(img.data);
      } else {
        const png = await dev.screenshotPng(s);
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(png);
      }
    },

    'GET /api/ui': async ({ res, url, serial }) => {
      const nodes = await dev.dumpUi(await serial());
      const all = url.searchParams.get('all') === '1';
      const list = all ? nodes : dev.interestingNodes(nodes);
      if (url.searchParams.get('format') === 'text') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(dev.formatUiNodes(list));
      } else json(res, 200, { nodes: list });
    },

    'GET /api/logcat': async ({ res, url, serial }) => {
      const p = url.searchParams;
      const r = await queryLogcat(await serial(), {
        lines: Number(p.get('lines') ?? 200),
        minLevel: (p.get('level') ?? undefined) as Level | undefined,
        tag: p.get('tag') ?? undefined,
        pkg: p.get('pkg') ?? undefined,
        grep: p.get('grep') ?? undefined,
        buffer: p.get('buffer') ?? undefined,
      });
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end((r.note ? `# ${r.note}\n` : '') + r.entries.map(formatEntry).join('\n'));
    },

    'POST /api/logcat/clear': async ({ res, serial }) => {
      await clearLogcat(await serial());
      json(res, 200, { ok: true });
    },

    'GET /api/pid': async ({ res, url, serial }) => json(res, 200, { pids: await dev.pidOf(await serial(), required(url, 'pkg')) }),

    'GET /api/apps': async ({ res, url, serial }) =>
      json(res, 200, {
        packages: await dev.listPackages(await serial(), {
          filter: url.searchParams.get('filter') ?? undefined,
          includeSystem: url.searchParams.get('system') === '1',
        }),
      }),

    'GET /api/current-app': async ({ res, serial }) => json(res, 200, await dev.currentApp(await serial())),

    'POST /api/input': async ({ req, res, serial }) => {
      const s = await serial();
      const b = await readJson(req);
      switch (b.type) {
        case 'tap':
          await dev.tap(s, b.x, b.y);
          break;
        case 'swipe':
          await dev.swipe(s, b.x1, b.y1, b.x2, b.y2, b.duration ?? 300);
          break;
        case 'longPress':
          await dev.longPress(s, b.x, b.y, b.duration ?? 800);
          break;
        case 'key':
          await dev.pressKey(s, b.key);
          break;
        case 'text':
          if (b.method === 'keys') await dev.inputTextAscii(s, b.text);
          else await pasteText(s, b.text);
          break;
        default:
          throw new HttpError(400, `Tipo de entrada desconhecido: ${b.type}`);
      }
      json(res, 200, { ok: true });
    },

    'GET /api/files': async ({ res, url, serial }) =>
      json(res, 200, { path: url.searchParams.get('path') ?? '/sdcard', entries: await dev.listDir(await serial(), url.searchParams.get('path') ?? '/sdcard') }),

    'GET /api/files/download': async ({ req, res, url, serial }) => {
      const s = await serial();
      const path = required(url, 'path');
      const stat = (await shell(s, `[ -f ${q(path)} ] && stat -L -c %s ${q(path)}`, { allowFailure: true })).trim();
      const size = Number(stat);
      if (!stat || !Number.isFinite(size)) throw new HttpError(404, `Arquivo não encontrado ou não é um arquivo comum: ${path}`);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(size),
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(path))}`,
      });
      const child = spawnAdb(['exec-out', `cat ${q(path)}`], s);
      req.on('close', () => child.kill());
      await pipeline(child.stdout!, res);
    },

    'POST /api/files/upload': async ({ req, res, url, serial }) => {
      const s = await serial();
      const dir = required(url, 'dir');
      const name = safeName(required(url, 'name'));
      const tmp = await bodyToTemp(req, name);
      try {
        const remote = dir.endsWith('/') ? dir + name : `${dir}/${name}`;
        json(res, 200, { ok: true, remote, result: (await dev.push(s, tmp, remote)).replace(tmp, name) });
      } finally {
        await unlink(tmp).catch(() => {});
      }
    },

    'POST /api/files/delete': async ({ res, url, serial }) => {
      await dev.removePath(await serial(), required(url, 'path'));
      json(res, 200, { ok: true });
    },

    'POST /api/files/mkdir': async ({ res, url, serial }) => {
      await dev.makeDir(await serial(), required(url, 'path'));
      json(res, 200, { ok: true });
    },

    'POST /api/install': async ({ req, res, url, serial }) => {
      const s = await serial();
      const name = safeName(url.searchParams.get('name') ?? 'app.apk');
      const tmp = await bodyToTemp(req, name.endsWith('.apk') ? name : `${name}.apk`);
      try {
        json(res, 200, { ok: true, result: await dev.installApk(tmp, s) });
      } finally {
        await unlink(tmp).catch(() => {});
      }
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (!isAllowedRequest(req, port)) throw new HttpError(403, 'Origem não permitida.');
      const route = routes[`${req.method} ${url.pathname}`];
      if (route) {
        await route({ req, res, url, serial: () => resolveSerial(url.searchParams.get('serial') ?? undefined) });
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(url.pathname, res);
      throw new HttpError(404, 'Rota não encontrada.');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof AdbError ? 502 : 500;
      if (!res.headersSent) json(res, status, { error: (err as Error).message });
      else res.destroy();
    }
  });

  // ------------------------------------------------------------ WebSockets
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const eventClients = new Set<WebSocket>();
  tracker.on('change', (devices) => {
    const msg = JSON.stringify({ type: 'devices', devices });
    for (const ws of eventClients) ws.send(msg);
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (!isAllowedRequest(req, port)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, async (ws) => {
      try {
        if (url.pathname === '/ws/events') {
          eventClients.add(ws);
          ws.on('close', () => eventClients.delete(ws));
          ws.send(JSON.stringify({ type: 'devices', devices: tracker.devices }));
          return;
        }
        const serial = await resolveSerial(url.searchParams.get('serial') ?? undefined);
        if (url.pathname === '/ws/mirror') {
          const p = url.searchParams;
          const opt = (k: string) => (p.has(k) ? Number(p.get(k)) : undefined);
          await hub.addViewer(serial, ws, {
            maxSize: opt('maxSize'),
            bitRate: opt('bitRate'),
            maxFps: opt('maxFps'),
            stayAwake: p.get('stayAwake') === '1',
            showTouches: p.get('showTouches') === '1',
          });
        } else if (url.pathname === '/ws/logcat') {
          const stream = new LogcatStream(serial, Number(url.searchParams.get('backlog') ?? 2000));
          stream.on('entries', (entries: LogEntry[]) => {
            if (ws.readyState !== ws.OPEN) return;
            ws.send(JSON.stringify({ type: 'entries', entries: entries.map((e) => [e.time, e.pid, e.tid, e.level, e.tag, e.msg]) }));
          });
          ws.on('close', () => stream.stop());
          stream.start();
        } else {
          ws.close(4004, 'unknown endpoint');
        }
      } catch (err) {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'error', message: (err as Error).message }));
          ws.close(4000, 'error');
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  return {
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
    async close() {
      tracker.stop();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function serveStatic(pathname: string, res: http.ServerResponse): void {
  const rel = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname)).replace(/^([/\\])+/, '');
  const file = join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Não encontrado');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  createReadStream(file).pipe(res);
}

/** Bloqueia DNS rebinding e requisições cross-site vindas de outras páginas abertas no navegador. */
function isAllowedRequest(req: http.IncomingMessage, port: number): boolean {
  const okHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (!okHosts.has(req.headers.host ?? '')) return false;
  const origin = req.headers.origin;
  if (origin && !okHosts.has(origin.replace(/^https?:\/\//, ''))) return false;
  return true;
}

function required(url: URL, key: string): string {
  const v = url.searchParams.get(key);
  if (!v) throw new HttpError(400, `Parâmetro obrigatório ausente: ${key}`);
  return v;
}

function safeName(name: string): string {
  const n = basename(name.replace(/\\/g, '/')).replace(/[\0\r\n]/g, '').trim();
  if (!n || n === '.' || n === '..') throw new HttpError(400, 'Nome de arquivo inválido.');
  return n;
}
