// Leitura e stream do logcat no formato "threadtime".
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { run, spawnAdb, q } from './adb.ts';
import { pidOf } from './device.ts';

export const LEVELS = ['V', 'D', 'I', 'W', 'E', 'F'] as const;
export type Level = (typeof LEVELS)[number];

export interface LogEntry {
  /** "MM-DD HH:MM:SS.mmm" */
  time: string;
  pid: number;
  tid: number;
  level: Level | 'S';
  tag: string;
  msg: string;
}

const LINE_RE = /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+(.*?)\s*:\s?(.*)$/;

export function parseLine(line: string): LogEntry | null {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  return { time: m[1]!, pid: Number(m[2]), tid: Number(m[3]), level: m[4] as Level, tag: m[5]!, msg: m[6]! };
}

export const levelRank = (l: string) => {
  const i = LEVELS.indexOf(l as Level);
  return i < 0 ? 99 : i;
};

export function formatEntry(e: LogEntry): string {
  return `${e.time} ${String(e.pid).padStart(5)} ${String(e.tid).padStart(5)} ${e.level} ${e.tag}: ${e.msg}`;
}

export interface LogQuery {
  lines?: number;
  minLevel?: Level;
  tag?: string;
  /** Filtra pelo(s) PID(s) atuais do pacote. */
  pkg?: string;
  /** Regex (case-insensitive) aplicada a tag + mensagem. */
  grep?: string;
  /** main, system, crash, events, radio, all */
  buffer?: string;
}

export interface LogResult {
  entries: LogEntry[];
  /** Linhas que não seguem o formato (cabeçalhos "--------- beginning of", continuação). */
  note?: string;
}

/** Despejo pontual (logcat -d), pensado para agentes de IA. */
export async function queryLogcat(serial: string, query: LogQuery = {}): Promise<LogResult> {
  const lines = Math.max(1, Math.min(query.lines ?? 200, 5000));
  const args = ['logcat', '-d', '-v', 'threadtime'];
  if (query.buffer) args.push('-b', query.buffer);

  let note: string | undefined;
  // null = sem filtro de pacote; vários PIDs (processos :remote etc.) são filtrados localmente.
  let pidSet: Set<number> | null = null;
  if (query.pkg) {
    const pids = await pidOf(serial, query.pkg);
    if (!pids.length) note = `O pacote ${query.pkg} não está em execução; mostrando entradas que citam o pacote.`;
    else if (pids.length === 1) args.push(`--pid=${pids[0]}`);
    pidSet = new Set(pids);
  }
  // O logcat aplica "-t N" ANTES dos filtros de nível/PID: com qualquer filtro, "-t" perderia
  // entradas. Nesses casos lê o buffer inteiro (filtrado no aparelho quando possível) e corta aqui.
  // Sem filtros, a folga cobre as linhas "--------- beginning of ..." que não são entradas.
  const anyFilter = Boolean(query.minLevel || query.pkg || query.grep || query.tag);
  if (!anyFilter) args.push('-t', String(lines + 10));
  if (query.minLevel) args.push(`*:${query.minLevel}`);

  const command = args.map((a) => (/^[\w:=*.\/-]+$/.test(a) ? a : q(a))).join(' ');
  const out = (await run(['shell', command], { serial, timeoutMs: 60000 })).stdout.toString('utf8').replace(/\r\n/g, '\n');

  let re: RegExp | null = null;
  if (query.grep) {
    try {
      re = new RegExp(query.grep, 'i');
    } catch {
      re = new RegExp(query.grep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
  }
  const tag = query.tag?.toLowerCase();
  const entries: LogEntry[] = [];
  for (const line of out.split('\n')) {
    const e = parseLine(line);
    if (!e) continue;
    if (tag && !e.tag.toLowerCase().includes(tag)) continue;
    if (pidSet && pidSet.size > 1 && !pidSet.has(e.pid)) continue;
    if (pidSet && pidSet.size === 0 && !(e.msg.includes(query.pkg!) || e.tag.includes(query.pkg!))) continue;
    if (re && !re.test(`${e.tag}: ${e.msg}`)) continue;
    entries.push(e);
  }
  return { entries: entries.slice(-lines), note };
}

export async function clearLogcat(serial: string, buffer = 'all'): Promise<void> {
  await run(['logcat', '-b', buffer, '-c'], { serial, timeoutMs: 15000, allowFailure: true });
}

/**
 * Stream contínuo. Emite 'entries' em lotes (a cada ~100 ms) para não inundar o WebSocket.
 * Reinicia sozinho se o processo cair enquanto o celular segue conectado.
 */
export class LogcatStream extends EventEmitter {
  private child: ChildProcess | null = null;
  private pending: LogEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private serial: string;
  private backlog: number;

  constructor(serial: string, backlog = 1000) {
    super();
    this.serial = serial;
    this.backlog = backlog;
  }

  start(): void {
    if (this.stopped) return;
    const child = spawnAdb(['logcat', '-v', 'threadtime', '-T', String(this.backlog)], this.serial);
    this.child = child;
    // Após reinício só interessa o que é novo.
    this.backlog = 1;
    let rest = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop() ?? '';
      for (const raw of lines) {
        const e = parseLine(raw.replace(/\r$/, ''));
        if (e) this.pending.push(e);
      }
      if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 100);
    });
    child.on('close', () => {
      this.child = null;
      if (!this.stopped) setTimeout(() => this.start(), 1500);
    });
    child.on('error', (err) => this.emit('error', err));
  }

  private flush(): void {
    this.flushTimer = null;
    if (!this.pending.length) return;
    const batch = this.pending;
    this.pending = [];
    this.emit('entries', batch);
  }

  stop(): void {
    this.stopped = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.child?.kill();
  }
}
