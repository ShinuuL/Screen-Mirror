// Operações de alto nível sobre um celular (por serial), usadas pelo painel web e pelo servidor MCP.
import { run, shell, execOut, q, AdbError } from './adb.ts';

// ---------------------------------------------------------------- informações

export interface DeviceInfo {
  serial: string;
  manufacturer: string;
  model: string;
  android: string;
  sdk: number;
  abi: string;
  /** Resolução efetiva (considera override do "wm size"). */
  width: number;
  height: number;
  density: number;
  battery: number | null;
  charging: string;
  screenOn: boolean | null;
}

export async function getInfo(serial: string): Promise<DeviceInfo> {
  const script = [
    'echo "manufacturer=$(getprop ro.product.manufacturer)"',
    'echo "model=$(getprop ro.product.model)"',
    'echo "android=$(getprop ro.build.version.release)"',
    'echo "sdk=$(getprop ro.build.version.sdk)"',
    'echo "abi=$(getprop ro.product.cpu.abi)"',
    `echo "size=$(wm size | tail -n 1 | sed 's/.*: //')"`,
    `echo "density=$(wm density | tail -n 1 | sed 's/.*: //')"`,
    `echo "battery=$(dumpsys battery | grep -m1 ' level:' | sed 's/.*: //')"`,
    `echo "status=$(dumpsys battery | grep -m1 ' status:' | sed 's/.*: //')"`,
    `echo "wake=$(dumpsys power | grep -m1 'mWakefulness=' | sed 's/.*=//')"`,
  ].join('; ');
  const out = await shell(serial, script, { timeoutMs: 15000 });
  const kv: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const [w, h] = (kv.size ?? '').split('x').map(Number);
  const statusNames: Record<string, string> = { '1': 'desconhecido', '2': 'carregando', '3': 'descarregando', '4': 'não carregando', '5': 'cheia' };
  return {
    serial,
    manufacturer: kv.manufacturer ?? '',
    model: kv.model ?? '',
    android: kv.android ?? '',
    sdk: Number(kv.sdk) || 0,
    abi: kv.abi ?? '',
    width: w || 0,
    height: h || 0,
    density: Number(kv.density) || 0,
    battery: kv.battery ? Number(kv.battery) : null,
    charging: statusNames[kv.status ?? ''] ?? kv.status ?? '',
    screenOn: kv.wake ? kv.wake === 'Awake' : null,
  };
}

// ---------------------------------------------------------------- captura de tela

/** PNG em resolução nativa via screencap (independe do espelhamento estar ativo). */
export async function screenshotPng(serial: string): Promise<Buffer> {
  const png = await execOut(serial, 'screencap -p', { timeoutMs: 20000 });
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) {
    throw new AdbError(`screencap não retornou um PNG válido: ${png.subarray(0, 200).toString('utf8')}`);
  }
  return png;
}

export function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

export interface ScaledImage {
  data: Buffer;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  deviceWidth: number;
  deviceHeight: number;
  /** imagem = dispositivo × scale */
  scale: number;
}

/**
 * Reduz a captura para agentes de IA (menos tokens/latência). Se o sharp não estiver
 * disponível, devolve o PNG original.
 */
export async function screenshotForAgent(
  serial: string,
  opts: { maxSize?: number; format?: 'jpeg' | 'png'; quality?: number } = {},
): Promise<ScaledImage> {
  const png = await screenshotPng(serial);
  const { width, height } = pngSize(png);
  const maxSize = opts.maxSize ?? 1600;
  const scale = Math.min(1, maxSize / Math.max(width, height));
  const format = opts.format ?? 'jpeg';
  try {
    const sharp = (await import('sharp')).default;
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    let img = sharp(png).resize(w, h);
    const data =
      format === 'png' ? await img.png({ compressionLevel: 6 }).toBuffer() : await img.jpeg({ quality: opts.quality ?? 80 }).toBuffer();
    return { data, mimeType: format === 'png' ? 'image/png' : 'image/jpeg', width: w, height: h, deviceWidth: width, deviceHeight: height, scale: w / width };
  } catch {
    return { data: png, mimeType: 'image/png', width, height, deviceWidth: width, deviceHeight: height, scale: 1 };
  }
}

// ---------------------------------------------------------------- entrada

export const KEYCODES: Record<string, number> = {
  HOME: 3, BACK: 4, CALL: 5, ENDCALL: 6,
  DPAD_UP: 19, DPAD_DOWN: 20, DPAD_LEFT: 21, DPAD_RIGHT: 22, DPAD_CENTER: 23,
  UP: 19, DOWN: 20, LEFT: 21, RIGHT: 22,
  VOLUME_UP: 24, VOLUME_DOWN: 25, POWER: 26, CAMERA: 27,
  TAB: 61, SPACE: 62, ENTER: 66, DEL: 67, BACKSPACE: 67, MENU: 82, SEARCH: 84,
  MEDIA_PLAY_PAUSE: 85, MEDIA_NEXT: 87, MEDIA_PREVIOUS: 88, PAGE_UP: 92, PAGE_DOWN: 93,
  ESCAPE: 111, FORWARD_DEL: 112, DELETE: 112, MOVE_HOME: 122, MOVE_END: 123,
  VOLUME_MUTE: 164, APP_SWITCH: 187, RECENTS: 187, BRIGHTNESS_DOWN: 220, BRIGHTNESS_UP: 221,
  SLEEP: 223, WAKEUP: 224, NOTIFICATION: 83, COPY: 278, PASTE: 279, CUT: 277,
};

export function resolveKeycode(key: string | number): number {
  if (typeof key === 'number') return key;
  const k = key.trim().toUpperCase().replace(/^KEYCODE_/, '');
  if (/^\d+$/.test(k)) return Number(k);
  const code = KEYCODES[k];
  if (code === undefined) throw new AdbError(`Tecla desconhecida "${key}". Use um nome (${Object.keys(KEYCODES).join(', ')}) ou um keycode numérico.`);
  return code;
}

const int = (n: number) => String(Math.round(n));

export async function tap(serial: string, x: number, y: number): Promise<void> {
  await shell(serial, `input tap ${int(x)} ${int(y)}`, { timeoutMs: 10000 });
}

export async function swipe(serial: string, x1: number, y1: number, x2: number, y2: number, durationMs = 300): Promise<void> {
  await shell(serial, `input swipe ${int(x1)} ${int(y1)} ${int(x2)} ${int(y2)} ${int(durationMs)}`, { timeoutMs: 10000 + durationMs });
}

export async function longPress(serial: string, x: number, y: number, durationMs = 800): Promise<void> {
  await swipe(serial, x, y, x, y, durationMs);
}

export async function pressKey(serial: string, key: string | number, longPress = false): Promise<number> {
  const code = resolveKeycode(key);
  await shell(serial, `input keyevent ${longPress ? '--longpress ' : ''}${code}`, { timeoutMs: 10000 });
  return code;
}

export const isAsciiPrintable = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** Digita texto ASCII via "input text". Para acentos/emoji use pasteText() do módulo scrcpy. */
export async function inputTextAscii(serial: string, text: string): Promise<void> {
  if (!isAsciiPrintable(text)) throw new AdbError('input text só aceita ASCII imprimível.');
  // "input text" interpreta %s como espaço.
  await shell(serial, `input text ${q(text.replace(/ /g, '%s'))}`, { timeoutMs: 30000 });
}

// ---------------------------------------------------------------- árvore de interface

export interface UiNode {
  index: number;
  depth: number;
  text: string;
  desc: string;
  id: string;
  cls: string;
  pkg: string;
  clickable: boolean;
  longClickable: boolean;
  scrollable: boolean;
  focusable: boolean;
  focused: boolean;
  enabled: boolean;
  checkable: boolean;
  checked: boolean;
  selected: boolean;
  password: boolean;
  bounds: [number, number, number, number];
  center: [number, number];
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (s: string) =>
  s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return XML_ENTITIES[e] ?? m;
  });

export function parseUiXml(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  const tagRe = /<node\b([^>]*?)(\/?)>|<\/node>/g;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml))) {
    if (m[0] === '</node>') {
      depth--;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of m[1]!.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]!] = decodeXml(a[2]!);
    const b = (attrs.bounds ?? '').match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    const bounds: [number, number, number, number] = b ? [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])] : [0, 0, 0, 0];
    const flag = (k: string) => attrs[k] === 'true';
    nodes.push({
      index: nodes.length,
      depth,
      text: attrs.text ?? '',
      desc: attrs['content-desc'] ?? '',
      id: attrs['resource-id'] ?? '',
      cls: (attrs.class ?? '').replace(/^android\.(widget|view)\./, ''),
      pkg: attrs.package ?? '',
      clickable: flag('clickable'),
      longClickable: flag('long-clickable'),
      scrollable: flag('scrollable'),
      focusable: flag('focusable'),
      focused: flag('focused'),
      enabled: flag('enabled'),
      checkable: flag('checkable'),
      checked: flag('checked'),
      selected: flag('selected'),
      password: flag('password'),
      bounds,
      center: [Math.round((bounds[0] + bounds[2]) / 2), Math.round((bounds[1] + bounds[3]) / 2)],
    });
    if (m[2] !== '/') depth++;
  }
  return nodes;
}

export async function dumpUiXml(serial: string): Promise<string> {
  const path = '/data/local/tmp/screen-mirror-ui.xml';
  const out = await shell(serial, `uiautomator dump ${path} >/dev/null 2>&1; cat ${path}; rm -f ${path}`, { timeoutMs: 30000 });
  const start = out.indexOf('<?xml');
  if (start < 0) {
    throw new AdbError(
      `uiautomator dump falhou (tela com animação contínua, ou app com FLAG_SECURE?): ${out.trim().slice(0, 300) || 'sem saída'}`,
    );
  }
  return out.slice(start);
}

export async function dumpUi(serial: string): Promise<UiNode[]> {
  return parseUiXml(await dumpUiXml(serial));
}

/** Nós relevantes para um agente: com texto/descrição/id ou interativos. */
export function interestingNodes(nodes: UiNode[]): UiNode[] {
  return nodes.filter((n) => {
    const [x1, y1, x2, y2] = n.bounds;
    if (x2 - x1 <= 0 || y2 - y1 <= 0) return false;
    return n.text || n.desc || n.clickable || n.scrollable || n.longClickable || n.checkable || n.cls.includes('EditText');
  });
}

export function formatUiNodes(nodes: UiNode[]): string {
  const minDepth = nodes.reduce((m, n) => Math.min(m, n.depth), Infinity);
  return nodes
    .map((n) => {
      const parts = [`[${n.index}]`, n.cls || 'View'];
      if (n.text) parts.push(JSON.stringify(n.password ? '••••' : n.text));
      if (n.desc) parts.push(`desc=${JSON.stringify(n.desc)}`);
      if (n.id) parts.push(`id=${n.id.replace(/^[\w.]+:id\//, '')}`);
      const flags = [
        n.clickable && 'clickable',
        n.longClickable && 'long-clickable',
        n.scrollable && 'scrollable',
        n.checkable && (n.checked ? 'checked' : 'unchecked'),
        n.focused && 'focused',
        n.selected && 'selected',
        !n.enabled && 'disabled',
      ].filter(Boolean);
      if (flags.length) parts.push(flags.join(','));
      parts.push(`center=(${n.center[0]},${n.center[1]})`);
      parts.push(`bounds=[${n.bounds.join(',')}]`);
      return '  '.repeat(Math.max(0, Math.min(n.depth - minDepth, 12))) + parts.join(' ');
    })
    .join('\n');
}

export interface UiQuery {
  text?: string;
  id?: string;
  desc?: string;
  exact?: boolean;
}

export function findNodes(nodes: UiNode[], query: UiQuery): UiNode[] {
  const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const match = (value: string, wanted?: string) => {
    if (wanted === undefined) return true;
    if (query.exact) return value === wanted;
    return norm(value).includes(norm(wanted));
  };
  const idMatch = (value: string, wanted?: string) =>
    wanted === undefined || value === wanted || value.endsWith(`:id/${wanted}`) || (!query.exact && value.includes(wanted));
  return nodes.filter(
    (n) => (query.text === undefined || match(n.text, query.text) || match(n.desc, query.text)) && match(n.desc, query.desc) && idMatch(n.id, query.id),
  );
}

// ---------------------------------------------------------------- apps

export async function currentApp(serial: string): Promise<{ package: string; activity: string; raw: string }> {
  const out = await shell(
    serial,
    `dumpsys activity activities | grep -m1 -E 'topResumedActivity|mResumedActivity|ResumedActivity:'; dumpsys window | grep -m1 -E 'mCurrentFocus|mFocusedApp'`,
    { timeoutMs: 15000 },
  );
  const m = out.match(/([a-zA-Z][\w.]*)\/([\w.$]+)/);
  return { package: m?.[1] ?? '', activity: m ? (m[2]!.startsWith('.') ? m[1] + m[2] : m[2]!) : '', raw: out.trim() };
}

export async function listPackages(serial: string, opts: { filter?: string; includeSystem?: boolean } = {}): Promise<string[]> {
  const out = await shell(serial, `pm list packages${opts.includeSystem ? '' : ' -3'}`, { timeoutMs: 30000 });
  const f = opts.filter?.toLowerCase();
  return out
    .split('\n')
    .map((l) => l.replace(/^package:/, '').trim())
    .filter((p) => p && (!f || p.toLowerCase().includes(f)))
    .sort();
}

export async function startApp(serial: string, pkg: string): Promise<string> {
  const out = await shell(serial, `monkey -p ${q(pkg)} -c android.intent.category.LAUNCHER 1 2>&1`, { timeoutMs: 20000 });
  if (/No activities found|monkey aborted/i.test(out)) throw new AdbError(`Não foi possível abrir ${pkg}: ${out.trim()}`);
  return out.trim();
}

export async function stopApp(serial: string, pkg: string): Promise<void> {
  await shell(serial, `am force-stop ${q(pkg)}`, { timeoutMs: 15000 });
}

export async function pidOf(serial: string, pkg: string): Promise<number[]> {
  const out = await shell(serial, `pidof ${q(pkg)}`, { timeoutMs: 10000, allowFailure: true });
  return out.trim().split(/\s+/).filter(Boolean).map(Number);
}

export async function installApk(localPath: string, serial: string): Promise<string> {
  const r = await run(['install', '-r', localPath], { serial, timeoutMs: 5 * 60_000 });
  return r.stdout.toString('utf8').trim();
}

// ---------------------------------------------------------------- arquivos

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'link' | 'other';
  size: number;
  mtime: number;
}

const joinRemote = (dir: string, name: string) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);

export async function listDir(serial: string, dir: string): Promise<FileEntry[]> {
  // stat -L segue links (ex.: /sdcard). Separador "|" — nomes com "|" ficam no último campo.
  const base = dir.endsWith('/') ? dir : `${dir}/`;
  const out = await shell(
    serial,
    `find ${q(base)} -mindepth 1 -maxdepth 1 -exec stat -L -c '%F|%s|%Y|%n' {} + 2>/dev/null`,
    { timeoutMs: 30000, allowFailure: true },
  );
  const entries: FileEntry[] = [];
  for (const line of out.split('\n')) {
    const parts = line.split('|');
    if (parts.length < 4) continue;
    const [kind, size, mtime] = parts;
    const full = parts.slice(3).join('|');
    const name = full.slice(full.lastIndexOf('/') + 1);
    if (!name) continue;
    entries.push({
      name,
      path: joinRemote(dir, name),
      type: kind === 'directory' ? 'dir' : kind!.includes('regular') ? 'file' : kind === 'symbolic link' ? 'link' : 'other',
      size: Number(size) || 0,
      mtime: Number(mtime) || 0,
    });
  }
  if (!entries.length) {
    // Diferencia "pasta vazia" de "sem permissão / inexistente".
    const check = await shell(serial, `[ -d ${q(dir)} ] && [ -r ${q(dir)} ] && echo ok`, { allowFailure: true });
    if (!check.includes('ok')) throw new AdbError(`Pasta inexistente ou sem permissão de leitura: ${dir}`);
  }
  return entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
}

export async function pull(serial: string, remote: string, local: string): Promise<string> {
  const r = await run(['pull', remote, local], { serial, timeoutMs: 30 * 60_000 });
  return summary(r);
}

export async function push(serial: string, local: string, remote: string): Promise<string> {
  const r = await run(['push', local, remote], { serial, timeoutMs: 30 * 60_000 });
  const out = summary(r);
  // Faz a galeria/MTP enxergarem o arquivo novo.
  if (remote.startsWith('/sdcard') || remote.startsWith('/storage')) {
    await shell(serial, `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${q('file://' + remote)} >/dev/null 2>&1`, {
      allowFailure: true,
      timeoutMs: 10000,
    }).catch(() => {});
  }
  return out;
}

export async function removePath(serial: string, remote: string): Promise<void> {
  if (!remote || remote === '/' || /^\/(sdcard|storage\/emulated\/0)\/?$/.test(remote)) {
    throw new AdbError(`Recusado: remover "${remote}" apagaria uma raiz de armazenamento.`);
  }
  const out = await shell(serial, `rm -r ${q(remote)} 2>&1 && echo __ok__`, { allowFailure: true });
  if (!out.includes('__ok__')) throw new AdbError(`Falha ao remover ${remote}: ${out.trim()}`);
}

export async function makeDir(serial: string, remote: string): Promise<void> {
  const out = await shell(serial, `mkdir -p ${q(remote)} 2>&1 && echo __ok__`, { allowFailure: true });
  if (!out.includes('__ok__')) throw new AdbError(`Falha ao criar ${remote}: ${out.trim()}`);
}

/** Linha final do adb ("1 file pulled, 0 skipped. 3.2 MB/s ..."), que pode sair em stdout ou stderr. */
const summary = (r: { stdout: Buffer; stderr: string }) =>
  `${r.stdout.toString('utf8')}\n${r.stderr}`
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.includes('%]'))
    .pop()
    ?.trim() ?? '';
