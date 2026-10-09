// Cliente do protocolo do scrcpy-server v5 (https://github.com/Genymobile/scrcpy, doc/develop.md).
//
// Fluxo: push do servidor -> "adb forward tcp:0 localabstract:scrcpy_<scid>" -> app_process
// -> 1º socket (vídeo) recebe dummy byte + nome do aparelho + codec + pacotes; 2º socket = controle.
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomInt } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { run, shell, spawnAdb, AdbError } from './adb.ts';
import { SCRCPY_SERVER_LOCAL, SCRCPY_SERVER_REMOTE, SCRCPY_VERSION } from '../config.ts';

// ---------------------------------------------------------------- fila de bytes

class ByteQueue {
  private chunks: Buffer[] = [];
  length = 0;

  push(chunk: Buffer): void {
    if (!chunk.length) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  /** Lê n bytes sem consumir (n <= length). */
  peek(n: number): Buffer {
    const first = this.chunks[0]!;
    if (first.length >= n) return first.subarray(0, n);
    return Buffer.concat(this.chunks, Math.min(this.length, Math.max(n, 0))).subarray(0, n);
  }

  /** Consome n bytes (n <= length). */
  read(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0);
    const first = this.chunks[0]!;
    if (first.length >= n) {
      const out = first.subarray(0, n);
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.length -= n;
      return out;
    }
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const c = this.chunks[0]!;
      const take = Math.min(c.length, n - off);
      c.copy(out, off, 0, take);
      if (take === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(take);
      off += take;
    }
    this.length -= n;
    return out;
  }
}

// ---------------------------------------------------------------- mensagens de controle

export const POINTER_ID_MOUSE = -1n;
export const POINTER_ID_FINGER = -2n;
export const POINTER_ID_VIRTUAL_FINGER = -3n;

/** android.view.KeyEvent / MotionEvent actions */
export const Action = { DOWN: 0, UP: 1, MOVE: 2 } as const;

const MSG = {
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  BACK_OR_SCREEN_ON: 4,
  EXPAND_NOTIFICATION_PANEL: 5,
  EXPAND_SETTINGS_PANEL: 6,
  COLLAPSE_PANELS: 7,
  GET_CLIPBOARD: 8,
  SET_CLIPBOARD: 9,
  SET_DISPLAY_POWER: 10,
  ROTATE_DEVICE: 11,
  OPEN_HARD_KEYBOARD_SETTINGS: 15,
  START_APP: 16,
  RESET_VIDEO: 17,
} as const;

const u16fp = (f: number) => (f >= 1 ? 0xffff : Math.max(0, Math.round(f * 0x10000)));
const i16fp = (f: number) => (f >= 1 ? 0x7fff : f <= -1 ? -0x8000 : Math.round(f * 0x8000));

/** Trunca em fronteira de caractere UTF-8. */
function utf8(text: string, maxBytes: number): Buffer {
  const b = Buffer.from(text, 'utf8');
  if (b.length <= maxBytes) return b;
  let end = maxBytes;
  while (end > 0 && (b[end]! & 0xc0) === 0x80) end--;
  return b.subarray(0, end);
}

export interface Position {
  x: number;
  y: number;
  /** Tamanho do vídeo atual — o servidor ignora eventos gerados para outro tamanho. */
  width: number;
  height: number;
}

function writePosition(buf: Buffer, offset: number, p: Position): void {
  buf.writeInt32BE(Math.round(p.x), offset);
  buf.writeInt32BE(Math.round(p.y), offset + 4);
  buf.writeUInt16BE(p.width, offset + 8);
  buf.writeUInt16BE(p.height, offset + 10);
}

export const Control = {
  keycode(action: number, keycode: number, repeat = 0, metaState = 0): Buffer {
    const b = Buffer.alloc(14);
    b[0] = MSG.INJECT_KEYCODE;
    b[1] = action;
    b.writeInt32BE(keycode, 2);
    b.writeInt32BE(repeat, 6);
    b.writeInt32BE(metaState, 10);
    return b;
  },
  text(text: string): Buffer {
    const t = utf8(text, 300);
    const b = Buffer.alloc(5 + t.length);
    b[0] = MSG.INJECT_TEXT;
    b.writeUInt32BE(t.length, 1);
    t.copy(b, 5);
    return b;
  },
  touch(action: number, pointerId: bigint, pos: Position, pressure: number, actionButton = 0, buttons = 0): Buffer {
    const b = Buffer.alloc(32);
    b[0] = MSG.INJECT_TOUCH_EVENT;
    b[1] = action;
    b.writeBigUInt64BE(BigInt.asUintN(64, pointerId), 2);
    writePosition(b, 10, pos);
    b.writeUInt16BE(u16fp(pressure), 22);
    b.writeUInt32BE(actionButton >>> 0, 24);
    b.writeUInt32BE(buttons >>> 0, 28);
    return b;
  },
  /** hscroll/vscroll em "cliques" de roda, intervalo [-16, 16]. */
  scroll(pos: Position, hscroll: number, vscroll: number, buttons = 0): Buffer {
    const b = Buffer.alloc(21);
    b[0] = MSG.INJECT_SCROLL_EVENT;
    writePosition(b, 1, pos);
    b.writeInt16BE(i16fp(Math.max(-1, Math.min(1, hscroll / 16))), 13);
    b.writeInt16BE(i16fp(Math.max(-1, Math.min(1, vscroll / 16))), 15);
    b.writeInt32BE(buttons, 17);
    return b;
  },
  backOrScreenOn(action: number): Buffer {
    return Buffer.from([MSG.BACK_OR_SCREEN_ON, action]);
  },
  expandNotifications: () => Buffer.from([MSG.EXPAND_NOTIFICATION_PANEL]),
  expandSettings: () => Buffer.from([MSG.EXPAND_SETTINGS_PANEL]),
  collapsePanels: () => Buffer.from([MSG.COLLAPSE_PANELS]),
  /** copyKey: 0 nenhum, 1 copiar, 2 recortar */
  getClipboard: (copyKey = 0) => Buffer.from([MSG.GET_CLIPBOARD, copyKey]),
  setClipboard(sequence: bigint, text: string, paste: boolean): Buffer {
    const t = utf8(text, (1 << 18) - 14);
    const b = Buffer.alloc(14 + t.length);
    b[0] = MSG.SET_CLIPBOARD;
    b.writeBigUInt64BE(sequence, 1);
    b[9] = paste ? 1 : 0;
    b.writeUInt32BE(t.length, 10);
    t.copy(b, 14);
    return b;
  },
  setDisplayPower: (on: boolean) => Buffer.from([MSG.SET_DISPLAY_POWER, on ? 1 : 0]),
  rotate: () => Buffer.from([MSG.ROTATE_DEVICE]),
  resetVideo: () => Buffer.from([MSG.RESET_VIDEO]),
  startApp(name: string): Buffer {
    const t = utf8(name, 255);
    return Buffer.concat([Buffer.from([MSG.START_APP, t.length]), t]);
  },
};

// ---------------------------------------------------------------- sessão

export interface ScrcpyOptions {
  video?: boolean;
  control?: boolean;
  /** Maior dimensão do vídeo (0 = nativa). */
  maxSize?: number;
  bitRate?: number;
  maxFps?: number;
  stayAwake?: boolean;
  showTouches?: boolean;
  clipboardAutosync?: boolean;
}

export interface VideoPacket {
  config: boolean;
  key: boolean;
  pts: bigint;
  data: Buffer;
}

const FLAG_SESSION = 0x80; // MSB do 1º byte
const FLAG_CONFIG = 1n << 62n;
const FLAG_KEY = 1n << 61n;
const PTS_MASK = FLAG_KEY - 1n;

export const CODEC_NAMES: Record<number, string> = { 0x68323634: 'h264', 0x68323635: 'h265', 0x00617631: 'av1' };

/**
 * Uma conexão com o scrcpy-server.
 * Eventos: 'meta' (deviceName), 'session' ({width,height}), 'packet' (VideoPacket),
 * 'clipboard' (texto), 'ack' (bigint), 'log' (linha do servidor), 'close' (motivo).
 */
export class ScrcpySession extends EventEmitter {
  readonly serial: string;
  readonly opts: Required<ScrcpyOptions>;
  readonly scid = randomInt(1, 0x7fffffff);
  deviceName = '';
  codec = '';
  width = 0;
  height = 0;
  closed = false;
  logs: string[] = [];

  private proc: ChildProcess | null = null;
  private videoSocket: net.Socket | null = null;
  private controlSocket: net.Socket | null = null;
  private port = 0;
  private procExit: string | null = null;

  constructor(serial: string, opts: ScrcpyOptions = {}) {
    super();
    this.serial = serial;
    this.opts = {
      video: opts.video ?? true,
      control: opts.control ?? true,
      maxSize: opts.maxSize ?? 1920,
      bitRate: opts.bitRate ?? 8_000_000,
      maxFps: opts.maxFps ?? 60,
      stayAwake: opts.stayAwake ?? false,
      showTouches: opts.showTouches ?? false,
      clipboardAutosync: opts.clipboardAutosync ?? true,
    };
  }

  private get socketName(): string {
    return `scrcpy_${this.scid.toString(16).padStart(8, '0')}`;
  }

  private serverArgs(): string[] {
    const o = this.opts;
    const args = [
      `scid=${this.scid.toString(16).padStart(8, '0')}`,
      'log_level=info',
      'tunnel_forward=true',
      'audio=false',
      `video=${o.video}`,
      `control=${o.control}`,
      'cleanup=true',
      `clipboard_autosync=${o.clipboardAutosync}`,
    ];
    if (o.video) {
      args.push('video_codec=h264', `max_size=${o.maxSize}`, `video_bit_rate=${o.bitRate}`, `max_fps=${o.maxFps}`);
    }
    if (o.stayAwake) args.push('stay_awake=true');
    if (o.showTouches) args.push('show_touches=true');
    return args;
  }

  async start(): Promise<this> {
    if (!this.opts.video && !this.opts.control) throw new Error('Sessão sem vídeo e sem controle.');
    await ensureServer(this.serial);

    const fwd = await run(['forward', 'tcp:0', `localabstract:${this.socketName}`], { serial: this.serial, timeoutMs: 10000 });
    this.port = parseInt(fwd.stdout.toString('utf8').trim(), 10);
    if (!this.port) throw new AdbError(`adb forward não retornou porta: ${fwd.stdout.toString('utf8')}`);

    // Com cleanup=true o servidor apaga o próprio jar ao iniciar; por isso cada sessão roda de uma
    // cópia descartável e a cópia mestre permanece (sessões simultâneas não disputam o arquivo).
    const jar = `/data/local/tmp/sm-${this.scid.toString(16).padStart(8, '0')}.jar`;
    const cmd =
      `cp ${SCRCPY_SERVER_REMOTE} ${jar} && CLASSPATH=${jar} app_process / com.genymobile.scrcpy.Server ${SCRCPY_VERSION} ` +
      this.serverArgs().join(' ');
    const proc = spawnAdb(['shell', cmd], this.serial);
    this.proc = proc;
    const onLog = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.logs.push(line);
        if (this.logs.length > 200) this.logs.shift();
        this.emit('log', line);
      }
    };
    proc.stdout!.on('data', onLog);
    proc.stderr!.on('data', onLog);
    proc.on('close', (code) => {
      this.procExit = `scrcpy-server encerrou (código ${code})${this.logs.length ? ': ' + this.logs.slice(-5).join(' | ') : ''}`;
      this.close(this.procExit);
    });

    try {
      const first = await this.connectFirst();
      const firstIsVideo = this.opts.video;
      let control: { socket: net.Socket; queue: ByteQueue } | null = null;
      if (this.opts.video && this.opts.control) control = await this.connectPlain();
      // Como o cliente oficial: o forward não é mais necessário depois de conectado.
      void run(['forward', '--remove', `tcp:${this.port}`], { serial: this.serial, allowFailure: true });
      this.port = 0;

      if (firstIsVideo) {
        this.videoSocket = first.socket;
        this.attachVideo(first.socket, first.queue);
        if (control) {
          this.controlSocket = control.socket;
          this.attachControl(control.socket, control.queue, false);
        }
      } else {
        this.controlSocket = first.socket;
        this.attachControl(first.socket, first.queue, true);
      }
      await this.waitReady();
    } catch (err) {
      this.close((err as Error).message);
      throw err;
    }
    return this;
  }

  /** 1º socket: tenta até receber o dummy byte (o servidor leva ~0,5–2 s para escutar). */
  private connectFirst(): Promise<{ socket: net.Socket; queue: ByteQueue }> {
    const deadline = Date.now() + 10000;
    return new Promise((resolve, reject) => {
      const attempt = () => {
        if (this.closed) return reject(new Error(this.procExit ?? 'Sessão encerrada durante a conexão.'));
        if (Date.now() > deadline) return reject(new Error(`Tempo esgotado conectando ao scrcpy-server. ${this.logs.slice(-5).join(' | ')}`));
        const socket = net.connect(this.port, '127.0.0.1');
        socket.setNoDelay(true);
        let done = false;
        socket.once('data', (chunk: Buffer) => {
          done = true;
          socket.removeAllListeners('close');
          socket.removeAllListeners('error');
          socket.pause();
          const queue = new ByteQueue();
          queue.push(chunk.subarray(1)); // descarta o dummy byte
          resolve({ socket, queue });
        });
        const retry = () => {
          if (done) return;
          done = true;
          socket.destroy();
          setTimeout(attempt, 150);
        };
        socket.once('close', retry);
        socket.once('error', retry);
      };
      attempt();
    });
  }

  private connectPlain(): Promise<{ socket: net.Socket; queue: ByteQueue }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.port, '127.0.0.1', () => {
        socket.removeListener('error', reject);
        resolve({ socket, queue: new ByteQueue() });
      });
      socket.setNoDelay(true);
      socket.once('error', reject);
    });
  }

  private waitReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ready = () => (this.opts.video ? this.width > 0 : this.deviceName !== '');
      if (ready()) return resolve();
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`O scrcpy-server não enviou o cabeçalho do vídeo. ${this.logs.slice(-5).join(' | ')}`));
      }, 15000);
      const check = () => {
        if (ready()) {
          cleanup();
          resolve();
        }
      };
      const onClose = (reason: string) => {
        cleanup();
        reject(new Error(reason));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off('meta', check);
        this.off('session', check);
        this.off('close', onClose);
      };
      this.on('meta', check);
      this.on('session', check);
      this.on('close', onClose);
    });
  }

  private readDeviceMeta(q: ByteQueue): boolean {
    if (q.length < 64) return false;
    const raw = q.read(64);
    const end = raw.indexOf(0);
    this.deviceName = raw.subarray(0, end < 0 ? 64 : end).toString('utf8');
    this.emit('meta', this.deviceName);
    return true;
  }

  private attachVideo(socket: net.Socket, q: ByteQueue): void {
    let state: 'meta' | 'codec' | 'header' | 'body' = 'meta';
    let pending = { config: false, key: false, pts: 0n, size: 0 };

    const drain = () => {
      for (;;) {
        if (state === 'meta') {
          if (!this.readDeviceMeta(q)) return;
          state = 'codec';
        } else if (state === 'codec') {
          if (q.length < 4) return;
          const id = q.read(4).readUInt32BE(0);
          if (id === 0 || id === 1) {
            this.close(id === 0 ? 'Vídeo desabilitado pelo aparelho.' : 'Erro de configuração do vídeo no aparelho.');
            return;
          }
          this.codec = CODEC_NAMES[id] ?? `0x${id.toString(16)}`;
          state = 'header';
        } else if (state === 'header') {
          if (q.length < 12) return;
          const h = q.read(12);
          if (h[0]! & FLAG_SESSION) {
            this.width = h.readUInt32BE(4);
            this.height = h.readUInt32BE(8);
            this.emit('session', { width: this.width, height: this.height });
          } else {
            const ptsFlags = h.readBigUInt64BE(0);
            pending = {
              config: (ptsFlags & FLAG_CONFIG) !== 0n,
              key: (ptsFlags & FLAG_KEY) !== 0n,
              pts: ptsFlags & PTS_MASK,
              size: h.readUInt32BE(8),
            };
            state = 'body';
          }
        } else {
          if (q.length < pending.size) return;
          const data = q.read(pending.size);
          state = 'header';
          this.emit('packet', { config: pending.config, key: pending.key, pts: pending.pts, data } satisfies VideoPacket);
        }
      }
    };

    socket.on('data', (chunk: Buffer) => {
      q.push(chunk);
      drain();
    });
    socket.on('close', () => this.close('Conexão de vídeo encerrada.'));
    socket.on('error', () => {});
    socket.resume();
    drain();
  }

  private attachControl(socket: net.Socket, q: ByteQueue, hasMeta: boolean): void {
    let needMeta = hasMeta;
    const drain = () => {
      for (;;) {
        if (needMeta) {
          if (!this.readDeviceMeta(q)) return;
          needMeta = false;
        }
        if (q.length < 1) return;
        const type = q.peek(1)[0];
        if (type === 0) {
          // clipboard: [type][len u32][utf8]
          if (q.length < 5) return;
          const len = q.peek(5).readUInt32BE(1);
          if (q.length < 5 + len) return;
          q.read(5);
          this.emit('clipboard', q.read(len).toString('utf8'));
        } else if (type === 1) {
          if (q.length < 9) return;
          this.emit('ack', q.read(9).readBigUInt64BE(1));
        } else if (type === 2) {
          if (q.length < 5) return;
          const size = q.peek(5).readUInt16BE(3);
          if (q.length < 5 + size) return;
          q.read(5 + size); // saída UHID: não usada
        } else {
          this.emit('log', `Mensagem de dispositivo desconhecida (${type}); canal de controle descartado.`);
          q.read(q.length);
          return;
        }
      }
    };
    socket.on('data', (chunk: Buffer) => {
      q.push(chunk);
      drain();
    });
    socket.on('close', () => this.close('Conexão de controle encerrada.'));
    socket.on('error', () => {});
    socket.resume();
    drain();
  }

  get canControl(): boolean {
    return Boolean(this.controlSocket && !this.closed);
  }

  send(msg: Buffer): boolean {
    if (!this.controlSocket || this.closed) return false;
    return this.controlSocket.write(msg);
  }

  close(reason = 'Encerrada.'): void {
    if (this.closed) return;
    this.closed = true;
    this.videoSocket?.destroy();
    this.controlSocket?.destroy();
    this.proc?.kill();
    if (this.port) void run(['forward', '--remove', `tcp:${this.port}`], { serial: this.serial, allowFailure: true }).catch(() => {});
    this.emit('close', reason);
  }
}

// ---------------------------------------------------------------- utilidades

/**
 * Garante a cópia mestre do scrcpy-server no aparelho (compara o tamanho). Verifica a cada sessão:
 * é barato e cobre limpezas externas de /data/local/tmp.
 */
export async function ensureServer(serial: string): Promise<void> {
  if (!existsSync(SCRCPY_SERVER_LOCAL)) {
    throw new Error(`scrcpy-server não encontrado em ${SCRCPY_SERVER_LOCAL}. Rode "npm run setup".`);
  }
  const size = statSync(SCRCPY_SERVER_LOCAL).size;
  const remote = (await shell(serial, `stat -c %s ${SCRCPY_SERVER_REMOTE} 2>/dev/null`, { allowFailure: true })).trim();
  if (Number(remote) !== size) await run(['push', SCRCPY_SERVER_LOCAL, SCRCPY_SERVER_REMOTE], { serial, timeoutMs: 60000 });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Aguarda um evento da sessão que satisfaça `accept`, com tempo limite. */
function waitFor<T>(session: ScrcpySession, event: string, timeoutMs: number, accept: (v: T) => boolean = () => true): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`Tempo esgotado aguardando "${event}".`)), timeoutMs);
    const onEvent = (v: T) => accept(v) && done(null, v);
    const onClose = (reason: string) => done(new Error(reason));
    const done = (err: Error | null, v?: T) => {
      clearTimeout(timer);
      session.off(event, onEvent);
      session.off('close', onClose);
      if (err) reject(err);
      else resolve(v as T);
    };
    session.on(event, onEvent);
    session.once('close', onClose);
  });
}

/**
 * Digita qualquer texto (acentos, emoji) colando pela área de transferência do aparelho.
 * É atômico — campos com busca incremental não perdem caracteres, ao contrário de "input text".
 * Restaura o conteúdo anterior da área de transferência ao final.
 */
export async function pasteText(serial: string, text: string, { restoreClipboard = true } = {}): Promise<void> {
  const session = await new ScrcpySession(serial, { video: false, control: true, clipboardAutosync: false }).start();
  try {
    let previous: string | null = null;
    if (restoreClipboard) {
      // Área de transferência vazia não gera resposta: o tempo limite curto cobre esse caso.
      const got = waitFor<string>(session, 'clipboard', 1000);
      session.send(Control.getClipboard(0));
      previous = await got.catch(() => null);
    }
    const seq = BigInt(randomInt(1, 0x7fffffff));
    const acked = waitFor<bigint>(session, 'ack', 5000, (s) => s === seq);
    session.send(Control.setClipboard(seq, text, true));
    await acked;
    // O app lê a área de transferência de forma assíncrona ao processar o PASTE.
    await sleep(previous !== null ? 600 : 150);
    if (previous !== null) {
      session.send(Control.setClipboard(0n, previous, false));
      await sleep(100);
    }
  } finally {
    session.close('Colagem concluída.');
  }
}
