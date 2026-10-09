// Regras que limitam o que agentes de IA podem fazer no celular via MCP.
// Arquivo por usuário (~/.screen-mirror/policy.json), relido a cada ação: editar vale na hora.
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, renameSync } from 'node:fs';

export type Mode = 'read-only' | 'interactive' | 'full';

export interface Policy {
  /** Botão de emergência: true bloqueia tudo (exceto listar aparelhos). */
  paused: boolean;
  /**
   * read-only: só ver (tela, árvore, logs, arquivos); interactive: ver + tocar/digitar/abrir apps;
   * full: também ações de sistema liberadas abaixo.
   */
  mode: Mode;
  /** Apps em que o agente não pode ver nem tocar (aceita prefixo com *). */
  blockedApps: string[];
  /** Se não vazio, toques/digitação só nestes apps (e na tela inicial). */
  allowedApps: string[];
  allowShell: boolean;
  /** Com allowShell, o comando precisa começar com um destes (vazio = qualquer). */
  shellAllowPrefixes: string[];
  allowInstall: boolean;
  /** Cada instalação pede confirmação ao usuário numa janela do sistema (o agente não consegue aprovar). */
  installRequiresConfirmation: boolean;
  allowStopApp: boolean;
  allowPushFiles: boolean;
  allowPullFiles: boolean;
  /** Pastas do celular que o agente pode ler/listar/gravar. */
  filePaths: string[];
  /** Limite de toques/teclas/digitação por minuto. */
  maxActionsPerMinute: number;
  /** Registra cada ação em ~/.screen-mirror/audit.log. */
  audit: boolean;
}

export const POLICY_DIR = join(homedir(), '.screen-mirror');
export const POLICY_FILE = join(POLICY_DIR, 'policy.json');
export const AUDIT_FILE = join(POLICY_DIR, 'audit.log');

export const DEFAULT_POLICY: Policy = {
  paused: false,
  mode: 'interactive',
  blockedApps: [
    // bancos e pagamentos
    'com.itau*', 'br.com.itau*', 'com.nu.production', 'br.com.bb.android', 'br.com.bradesco*', 'com.bradesco*',
    'com.santander*', 'br.com.santander*', 'br.com.intermedium', 'br.com.gabba.Caixa', 'br.gov.caixa*', 'com.c6bank.app',
    'com.picpay', 'com.mercadopago.wallet', 'br.com.original.bank', 'com.btg.pactual*', 'br.com.sicredi*', 'com.sicoob*',
    'com.samsung.android.spay', 'com.google.android.apps.walletnfcrel', 'com.paypal.android.p2pmobile',
    // mensagens, e-mail e redes sociais
    'com.whatsapp', 'com.whatsapp.w4b', 'org.telegram.messenger', 'com.google.android.gm', 'com.microsoft.office.outlook',
    'com.samsung.android.messaging', 'com.google.android.apps.messaging', 'com.instagram.android',
    'com.facebook.katana', 'com.facebook.orca', 'com.zhiliaoapp.musically',
    // galeria/fotos, compras e configurações do sistema (reset, contas, segurança)
    'com.sec.android.gallery3d', 'com.google.android.apps.photos', 'com.android.vending',
    'com.android.settings', 'com.samsung.android.settings*',
    // senhas
    'com.google.android.gms.auth*', 'com.x8bit.bitwarden', 'com.lastpass.lpandroid', 'com.agilebits.onepassword',
  ],
  allowedApps: [],
  allowShell: false,
  shellAllowPrefixes: ['dumpsys', 'getprop', 'pm list', 'pm path', 'wm size', 'wm density', 'pidof', 'ps'],
  allowInstall: true,
  installRequiresConfirmation: true,
  allowStopApp: true,
  allowPushFiles: true,
  allowPullFiles: true,
  filePaths: ['/sdcard/Download', '/data/local/tmp'],
  maxActionsPerMinute: 60,
  audit: true,
};

let cache: { mtime: number; policy: Policy } | null = null;

/** Lê a política (cria com padrões seguros se não existir). Arquivo inválido = modo read-only. */
export function loadPolicy(): Policy {
  try {
    if (!existsSync(POLICY_FILE)) savePolicy(DEFAULT_POLICY);
    const mtime = statSync(POLICY_FILE).mtimeMs;
    if (cache?.mtime === mtime) return cache.policy;
    const policy = { ...DEFAULT_POLICY, ...JSON.parse(readFileSync(POLICY_FILE, 'utf8')) } as Policy;
    cache = { mtime, policy };
    return policy;
  } catch (err) {
    // Falha fechada: na dúvida, só leitura.
    process.stderr.write(`[policy] ${POLICY_FILE} inválido (${(err as Error).message}); usando read-only.\n`);
    return { ...DEFAULT_POLICY, mode: 'read-only', allowShell: false, allowInstall: false };
  }
}

export function savePolicy(policy: Policy): void {
  mkdirSync(POLICY_DIR, { recursive: true });
  const tmp = `${POLICY_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(policy, null, 2) + '\n');
  renameSync(tmp, POLICY_FILE);
  cache = null;
}

export function setPaused(paused: boolean): Policy {
  const p = { ...loadPolicy(), paused };
  savePolicy(p);
  return p;
}

const matches = (pkg: string, patterns: string[]) =>
  patterns.some((p) => (p.endsWith('*') ? pkg.startsWith(p.slice(0, -1)) : pkg === p));

export const isBlockedApp = (pkg: string, p: Policy) => Boolean(pkg) && matches(pkg, p.blockedApps);

const isHome = (pkg: string) => /launcher|systemui/i.test(pkg);

/** Toque/digitação permitidos no app em primeiro plano? */
export function inputAllowedIn(pkg: string, p: Policy): string | null {
  if (isBlockedApp(pkg, p)) return `o app em primeiro plano (${pkg}) está bloqueado para agentes`;
  if (p.allowedApps.length && !isHome(pkg) && !matches(pkg, p.allowedApps)) {
    return `o app em primeiro plano (${pkg}) não está na lista allowedApps`;
  }
  return null;
}

export function pathAllowed(path: string, p: Policy): boolean {
  const norm = path.replace(/\/+$/, '').replace(/^\/storage\/emulated\/0/, '/sdcard');
  if (norm.split('/').includes('..')) return false;
  return p.filePaths.some((base) => norm === base.replace(/\/+$/, '') || norm.startsWith(base.replace(/\/+$/, '') + '/'));
}

/** Comando shell: prefixo permitido e sem encadeamento/redirecionamento. */
export function shellAllowed(cmd: string, p: Policy): string | null {
  if (!p.allowShell) return 'shell desativado (allowShell=false)';
  if (/[;&|`$<>\n]/.test(cmd)) return 'encadeamento, redirecionamento e substituição de comandos não são permitidos';
  const c = cmd.trim();
  if (p.shellAllowPrefixes.length && !p.shellAllowPrefixes.some((pre) => c === pre || c.startsWith(pre + ' '))) {
    return `comando fora de shellAllowPrefixes (${p.shellAllowPrefixes.join(', ')})`;
  }
  return null;
}

// ---------------------------------------------------------------- limite e auditoria

const recent: number[] = [];

export function takeActionSlot(p: Policy): boolean {
  const now = Date.now();
  while (recent.length && now - recent[0]! > 60_000) recent.shift();
  if (recent.length >= p.maxActionsPerMinute) return false;
  recent.push(now);
  return true;
}

export function audit(p: Policy, entry: Record<string, unknown>): void {
  if (!p.audit) return;
  try {
    mkdirSync(dirname(AUDIT_FILE), { recursive: true });
    appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {}
}

// ---------------------------------------------------------------- confirmação do usuário

/**
 * Pergunta ao usuário numa janela nativa do sistema operacional, fora do alcance do agente.
 * Sem resposta em `timeoutMs`, ou sem como exibir a janela, a resposta é "não".
 */
export function confirmWithUser(title: string, message: string, timeoutMs = 120_000): Promise<boolean> {
  let cmd: string;
  let args: string[];
  // Texto vai por variável de ambiente: nunca é interpretado como código.
  const env = { ...process.env, SM_TITLE: title, SM_MESSAGE: message };
  if (process.platform === 'win32') {
    cmd = 'powershell.exe';
    args = [
      '-NoProfile', '-NonInteractive', '-Command',
      "Add-Type -AssemblyName System.Windows.Forms; " +
        "[System.Windows.Forms.MessageBox]::Show($env:SM_MESSAGE, $env:SM_TITLE, 'YesNo', 'Warning', 'Button2', 'DefaultDesktopOnly')",
    ];
  } else if (process.platform === 'darwin') {
    cmd = 'osascript';
    args = ['-e', 'display dialog (system attribute "SM_MESSAGE") with title (system attribute "SM_TITLE") buttons {"Não", "Sim"} default button "Não" with icon caution'];
  } else {
    cmd = 'zenity';
    args = ['--question', '--title', title, '--text', message];
  }
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(cmd, args, { env, windowsHide: false });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on('data', (c: Buffer) => (out += c.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (process.platform === 'win32') resolve(out.trim() === 'Yes');
      else if (process.platform === 'darwin') resolve(out.includes('Sim'));
      else resolve(code === 0);
    });
  });
}
