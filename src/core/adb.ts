// Wrapper fino sobre o executável adb. Toda comunicação com o celular passa por aqui.
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolveAdbPath } from '../config.ts';

export const ADB = resolveAdbPath();

export class AdbError extends Error {
  readonly code: number | null;
  readonly stderr: string;
  constructor(message: string, code: number | null = null, stderr = '') {
    super(message);
    this.name = 'AdbError';
    this.code = code;
    this.stderr = stderr;
  }
}

export interface RunOptions {
  serial?: string;
  timeoutMs?: number;
  input?: Buffer | string;
  /** Não lança erro em código de saída != 0. */
  allowFailure?: boolean;
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
  code: number | null;
}

const withSerial = (args: string[], serial?: string) => (serial ? ['-s', serial, ...args] : args);

/** Executa adb e coleta stdout binário. */
export function run(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const fullArgs = withSerial(args, opts.serial);
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(ADB, fullArgs, { windowsHide: true });
    } catch (err) {
      reject(new AdbError(`Não foi possível executar o adb (${ADB}): ${(err as Error).message}`));
      return;
    }
    const out: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill();
        reject(new AdbError(`Tempo esgotado (${opts.timeoutMs} ms): adb ${fullArgs.join(' ')}`));
      }, opts.timeoutMs);
    }
    child.stdout!.on('data', (c: Buffer) => out.push(c));
    child.stderr!.on('data', (c: Buffer) => errChunks.push(c));
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const hint = err.code === 'ENOENT' ? ' — instale o Android platform-tools ou defina ADB_PATH' : '';
      reject(new AdbError(`Falha ao executar adb: ${err.message}${hint}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(errChunks).toString('utf8').trim();
      if (code !== 0 && !opts.allowFailure) {
        const detail = stderr || stdout.toString('utf8').trim();
        reject(new AdbError(`adb ${args.join(' ')} falhou (código ${code}): ${detail}`, code, stderr));
        return;
      }
      resolve({ stdout, stderr, code });
    });
    if (opts.input !== undefined) child.stdin!.end(opts.input);
    else child.stdin!.end();
  });
}

/** Aspas simples para o sh do Android. */
export function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Executa um comando no shell do celular e devolve o texto. */
export async function shell(serial: string, command: string, opts: Omit<RunOptions, 'serial'> = {}): Promise<string> {
  const r = await run(['shell', command], { ...opts, serial });
  return r.stdout.toString('utf8').replace(/\r\n/g, '\n');
}

/** Como shell(), mas sem tradução de fim de linha: seguro para dados binários (PNG, arquivos). */
export async function execOut(serial: string, command: string, opts: Omit<RunOptions, 'serial'> = {}): Promise<Buffer> {
  return (await run(['exec-out', command], { ...opts, serial })).stdout;
}

export function spawnAdb(args: string[], serial?: string): ChildProcess {
  return spawn(ADB, withSerial(args, serial), { windowsHide: true });
}

// ---------------------------------------------------------------- dispositivos

export type DeviceState = 'device' | 'unauthorized' | 'offline' | 'recovery' | 'sideload' | 'bootloader' | string;

export interface DeviceEntry {
  serial: string;
  state: DeviceState;
  model?: string;
  product?: string;
  device?: string;
  transportId?: string;
  /** usb ou wifi (serial no formato ip:porta ou mDNS). */
  connection: 'usb' | 'wifi';
}

export function parseDevices(text: string): DeviceEntry[] {
  const list: DeviceEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('List of devices') || line.startsWith('*')) continue;
    const [serial, state, ...rest] = line.split(/\s+/);
    if (!serial || !state) continue;
    const entry: DeviceEntry = {
      serial,
      state,
      connection: /:\d+$/.test(serial) || serial.includes('._adb-tls-connect') ? 'wifi' : 'usb',
    };
    for (const kv of rest) {
      const i = kv.indexOf(':');
      if (i < 0) continue;
      const k = kv.slice(0, i);
      const v = kv.slice(i + 1);
      if (k === 'model') entry.model = v.replace(/_/g, ' ');
      else if (k === 'product') entry.product = v;
      else if (k === 'device') entry.device = v;
      else if (k === 'transport_id') entry.transportId = v;
    }
    list.push(entry);
  }
  return list;
}

export async function listDevices(): Promise<DeviceEntry[]> {
  const r = await run(['devices', '-l'], { timeoutMs: 15000 });
  return parseDevices(r.stdout.toString('utf8'));
}

/**
 * Resolve qual celular usar. Sem serial: usa o único conectado e autorizado.
 * Mensagens de erro orientam o usuário (autorização, depuração USB).
 */
export async function resolveSerial(serial?: string): Promise<string> {
  const devices = await listDevices();
  if (serial) {
    const d = devices.find((x) => x.serial === serial);
    if (!d) throw new AdbError(`Celular "${serial}" não encontrado. Conectados: ${devices.map((x) => x.serial).join(', ') || 'nenhum'}`);
    if (d.state !== 'device') throw new AdbError(stateHint(d));
    return serial;
  }
  const ready = devices.filter((d) => d.state === 'device');
  if (ready.length === 1) return ready[0]!.serial;
  if (ready.length > 1) {
    throw new AdbError(
      `Há ${ready.length} celulares conectados; informe o serial: ${ready.map((d) => `${d.serial} (${d.model ?? '?'})`).join(', ')}`,
    );
  }
  if (devices.length) throw new AdbError(devices.map(stateHint).join('; '));
  throw new AdbError(
    'Nenhum celular conectado. Conecte o cabo USB, ative "Depuração USB" nas Opções do desenvolvedor e aceite a chave RSA no celular.',
  );
}

function stateHint(d: DeviceEntry): string {
  switch (d.state) {
    case 'unauthorized':
      return `${d.serial}: não autorizado — desbloqueie o celular e aceite o aviso "Permitir depuração USB".`;
    case 'offline':
      return `${d.serial}: offline — reconecte o cabo ou rode "adb kill-server".`;
    default:
      return `${d.serial}: estado "${d.state}" (esperado "device").`;
  }
}

/**
 * Acompanha conexões/desconexões em tempo real via "adb track-devices -l".
 * Emite 'change' com a lista completa sempre que algo muda.
 */
export class DeviceTracker extends EventEmitter {
  devices: DeviceEntry[] = [];
  private child: ChildProcess | null = null;
  private stopped = false;
  private retry = 500;

  private poll: NodeJS.Timeout | null = null;

  async start(): Promise<void> {
    await run(['start-server'], { timeoutMs: 20000, allowFailure: true });
    this.spawn();
    // Reconciliação: se o track-devices perder um evento (reinício do servidor adb, troca de
    // driver USB no Windows), a lista se corrige em até 2 s.
    this.poll = setInterval(() => {
      listDevices()
        .then((list) => this.update(list))
        .catch(() => {});
    }, 2000);
  }

  private update(list: DeviceEntry[]): void {
    const key = (l: DeviceEntry[]) => l.map((d) => `${d.serial}:${d.state}`).sort().join('|');
    if (key(list) === key(this.devices)) return;
    this.devices = list;
    this.emit('change', list);
  }

  private spawn(): void {
    if (this.stopped) return;
    const child = spawnAdb(['track-devices', '-l']);
    this.child = child;
    let buf = Buffer.alloc(0);
    child.stdout!.on('data', (chunk: Buffer) => {
      this.retry = 500;
      buf = Buffer.concat([buf, chunk]);
      // Protocolo: 4 dígitos hex com o tamanho + payload, repetido.
      while (buf.length >= 4) {
        const len = parseInt(buf.subarray(0, 4).toString('ascii'), 16);
        if (Number.isNaN(len)) {
          buf = Buffer.alloc(0); // fora de sincronia: descarta; a reconciliação cobre
          break;
        }
        if (buf.length < 4 + len) break;
        const payload = buf.subarray(4, 4 + len).toString('utf8');
        buf = buf.subarray(4 + len);
        this.update(parseDevices(payload));
      }
    });
    child.on('error', (err) => this.emit('error', err));
    child.on('close', () => {
      this.child = null;
      if (this.stopped) return;
      // O servidor adb pode ter reiniciado; tenta de novo com backoff.
      setTimeout(() => this.spawn(), this.retry);
      this.retry = Math.min(this.retry * 2, 10000);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    this.child?.kill();
  }
}
