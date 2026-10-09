// Uma sessão scrcpy por celular, compartilhada entre todas as janelas/abas que estiverem assistindo.
import type { WebSocket } from 'ws';
import { ScrcpySession, Control, POINTER_ID_FINGER, POINTER_ID_MOUSE, type ScrcpyOptions, type VideoPacket } from '../core/scrcpy.ts';

interface Viewer {
  ws: WebSocket;
  /** Atrasado demais: descarta quadros até o próximo keyframe. */
  needKey: boolean;
}

const KIND = { config: 0, key: 1, delta: 2 } as const;
const MAX_GOP_BYTES = 32 * 1024 * 1024;
const MAX_VIEWER_BUFFER = 1024 * 1024; // acima disso o espectador está atrasado: pula até o próximo keyframe
const IDLE_STOP_MS = 10_000;

function frame(kind: number, pts: bigint, data: Buffer): Buffer {
  const head = Buffer.allocUnsafe(9);
  head[0] = kind;
  head.writeDoubleBE(Number(pts), 1);
  return Buffer.concat([head, data]);
}

const send = (ws: WebSocket, msg: object) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};

class DeviceMirror {
  readonly serial: string;
  session: ScrcpySession | null = null;
  private starting: Promise<void> | null = null;
  private viewers = new Set<Viewer>();
  private config: Buffer | null = null;
  private gop: Buffer[] = [];
  private gopBytes = 0;
  private gopValid = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private restarting = false;
  private opts: ScrcpyOptions = {};
  private onEmpty: () => void;

  constructor(serial: string, onEmpty: () => void) {
    this.serial = serial;
    this.onEmpty = onEmpty;
  }

  async addViewer(ws: WebSocket, opts: ScrcpyOptions): Promise<void> {
    const viewer: Viewer = { ws, needKey: false };
    this.viewers.add(viewer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        this.handleControl(JSON.parse(data.toString()));
      } catch (err) {
        send(ws, { type: 'warn', message: `Comando inválido: ${(err as Error).message}` });
      }
    });
    ws.on('close', () => {
      this.viewers.delete(viewer);
      if (!this.viewers.size) this.idleTimer = setTimeout(() => this.stop('Sem espectadores.'), IDLE_STOP_MS);
    });

    if (!this.session && !this.starting) this.opts = opts;
    try {
      await this.ensureSession();
      this.sendInit(viewer);
    } catch (err) {
      send(ws, { type: 'error', message: (err as Error).message });
      ws.close(4000, 'start failed');
    }
  }

  private ensureSession(): Promise<void> {
    if (this.session && !this.session.closed) return Promise.resolve();
    if (!this.starting) {
      this.starting = this.startSession().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async startSession(): Promise<void> {
    this.config = null;
    this.gop = [];
    this.gopBytes = 0;
    this.gopValid = false;
    const session = new ScrcpySession(this.serial, { ...this.opts, video: true, control: true });
    session.on('packet', (p: VideoPacket) => this.onPacket(p));
    session.on('session', (s: { width: number; height: number }) => this.broadcast({ type: 'size', ...s }));
    session.on('clipboard', (text: string) => this.broadcast({ type: 'clipboard', text }));
    session.on('log', (line: string) => process.stderr.write(`[scrcpy ${this.serial}] ${line}\n`));
    session.on('close', (reason: string) => {
      if (this.session === session) this.session = null;
      if (this.restarting) return;
      for (const v of this.viewers) {
        send(v.ws, { type: 'closed', reason });
        v.ws.close(4001, 'session closed');
      }
    });
    this.session = session;
    await session.start();
  }

  private sendInit(v: Viewer): void {
    const s = this.session;
    if (!s) return;
    send(v.ws, { type: 'init', serial: this.serial, deviceName: s.deviceName, codec: s.codec, width: s.width, height: s.height, opts: s.opts });
    if (this.config && this.gopValid && this.gop.length) {
      v.ws.send(this.config);
      for (const f of this.gop) v.ws.send(f);
    } else {
      // Sem keyframe em cache: pede um novo ao encoder em vez de esperar o intervalo de 10 s.
      v.needKey = true;
      s.send(Control.resetVideo());
    }
  }

  private onPacket(p: VideoPacket): void {
    if (p.config) {
      this.config = frame(KIND.config, 0n, p.data);
      this.gop = [];
      this.gopBytes = 0;
      this.gopValid = false;
      for (const v of this.viewers) v.ws.send(this.config);
      return;
    }
    const f = frame(p.key ? KIND.key : KIND.delta, p.pts, p.data);
    if (p.key) {
      this.gop = [f];
      this.gopBytes = f.length;
      this.gopValid = true;
    } else if (this.gopValid) {
      this.gopBytes += f.length;
      if (this.gopBytes > MAX_GOP_BYTES) {
        this.gop = [];
        this.gopValid = false;
      } else {
        this.gop.push(f);
      }
    }
    for (const v of this.viewers) {
      if (v.ws.readyState !== v.ws.OPEN) continue;
      if (v.ws.bufferedAmount > MAX_VIEWER_BUFFER) {
        v.needKey = true;
        continue;
      }
      if (v.needKey) {
        if (!p.key) continue;
        if (this.config) v.ws.send(this.config);
        v.needKey = false;
      }
      v.ws.send(f);
    }
  }

  private broadcast(msg: object): void {
    for (const v of this.viewers) send(v.ws, msg);
  }

  // Mensagens JSON do navegador; os campos numéricos passam por num(), que rejeita lixo.
  private handleControl(m: Record<string, any>): void {
    if (m.t === 'restart') {
      void this.restart(m.opts ?? {});
      return;
    }
    const s = this.session;
    if (!s?.canControl) return;
    const pos = () => ({ x: num(m.x), y: num(m.y), width: num(m.w), height: num(m.h) });
    switch (m.t) {
      case 'touch': {
        // Número = ponteiro de tela touch do PC (multitoque); senão mouse ou dedo genérico.
        const id = typeof m.id === 'number' ? BigInt(Math.trunc(m.id)) : m.id === 'mouse' ? POINTER_ID_MOUSE : POINTER_ID_FINGER;
        s.send(Control.touch(num(m.a), id, pos(), num(m.p ?? 1), num(m.ab ?? 0), num(m.b ?? 0)));
        break;
      }
      case 'scroll':
        s.send(Control.scroll(pos(), num(m.hs), num(m.vs), num(m.b ?? 0)));
        break;
      case 'key':
        s.send(Control.keycode(num(m.a), num(m.code), num(m.repeat ?? 0), num(m.meta ?? 0)));
        break;
      case 'text':
        if (typeof m.text === 'string' && m.text) s.send(Control.text(m.text));
        break;
      case 'paste':
        if (typeof m.text === 'string') s.send(Control.setClipboard(0n, m.text, true));
        break;
      case 'back':
        s.send(Control.backOrScreenOn(num(m.a)));
        break;
      case 'notifications':
        s.send(Control.expandNotifications());
        break;
      case 'settings':
        s.send(Control.expandSettings());
        break;
      case 'collapse':
        s.send(Control.collapsePanels());
        break;
      case 'displayPower':
        s.send(Control.setDisplayPower(Boolean(m.on)));
        break;
      case 'rotate':
        s.send(Control.rotate());
        break;
      case 'getClipboard':
        s.send(Control.getClipboard(num(m.copyKey ?? 0)));
        break;
      case 'reset':
        s.send(Control.resetVideo());
        break;
      case 'startApp':
        if (typeof m.name === 'string') s.send(Control.startApp(m.name));
        break;
    }
  }

  private async restart(opts: ScrcpyOptions): Promise<void> {
    this.opts = { ...this.opts, ...opts };
    this.restarting = true;
    this.session?.close('Reiniciando com novas opções.');
    this.session = null;
    try {
      await this.ensureSession();
      for (const v of this.viewers) this.sendInit(v);
    } catch (err) {
      this.broadcast({ type: 'error', message: (err as Error).message });
    } finally {
      this.restarting = false;
    }
  }

  stop(reason: string): void {
    if (this.viewers.size) return;
    this.session?.close(reason);
    this.session = null;
    this.onEmpty();
  }
}

const num = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`número inválido: ${String(v)}`);
  return n;
};

export class MirrorHub {
  private mirrors = new Map<string, DeviceMirror>();

  addViewer(serial: string, ws: WebSocket, opts: ScrcpyOptions): Promise<void> {
    let m = this.mirrors.get(serial);
    if (!m) {
      m = new DeviceMirror(serial, () => this.mirrors.delete(serial));
      this.mirrors.set(serial, m);
    }
    return m.addViewer(ws, opts);
  }

  /** Sessão ativa (se houver) — permite reaproveitar o canal de controle. */
  session(serial: string): ScrcpySession | null {
    return this.mirrors.get(serial)?.session ?? null;
  }

  active(): string[] {
    return [...this.mirrors.keys()];
  }
}
