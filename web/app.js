import { Mirror } from './mirror.js';
import { LogcatPanel } from './logcat.js';
import { FilesPanel } from './files.js';
import { hydrateIcons } from './icons.js';

const $ = (id) => document.getElementById(id);
hydrateIcons();

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`sm.${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`sm.${key}`, JSON.stringify(value));
    } catch {}
  },
};

function toast(message, isError = false) {
  const el = Object.assign(document.createElement('div'), { className: `toast${isError ? ' err' : ''}`, textContent: message });
  $('toasts').append(el);
  setTimeout(() => el.remove(), isError ? 7000 : 3500);
}

// ------------------------------------------------------------------ abas
function selectTab(name) {
  for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const b of document.querySelectorAll('.tab-body')) b.hidden = b.id !== `tab-${name}`;
  store.set('tab', name);
}
for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => selectTab(t.dataset.tab));
selectTab(store.get('tab', 'logcat'));

// ------------------------------------------------------------------ painel lateral (modo foco)
function setPanel(visible) {
  document.querySelector('.layout').classList.toggle('panel-hidden', !visible);
  const btn = $('toggle-panel');
  btn.setAttribute('aria-pressed', String(visible));
  btn.title = `${visible ? 'Esconder' : 'Mostrar'} painel lateral (Ctrl+Shift+L)`;
  store.set('panel', visible);
}
$('toggle-panel').addEventListener('click', () => setPanel($('toggle-panel').getAttribute('aria-pressed') !== 'true'));
// Atalho global; capturado antes do espelho para não ser enviado ao celular.
window.addEventListener(
  'keydown',
  (ev) => {
    if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyL') {
      ev.preventDefault();
      ev.stopPropagation();
      $('toggle-panel').click();
    }
  },
  true,
);
setPanel(store.get('panel', true));

// ------------------------------------------------------------------ painéis
const canvas = $('screen');
const mirror = new Mirror(canvas);
const logcat = new LogcatPanel({
  level: $('log-level'),
  pkg: $('log-package'),
  packages: $('package-list'),
  search: $('log-search'),
  pause: $('log-pause'),
  clear: $('log-clear'),
  clearDevice: $('log-clear-device'),
  export: $('log-export'),
  log: $('log'),
  count: $('log-count'),
  follow: $('log-follow'),
});
const files = new FilesPanel(
  {
    path: $('files-path'),
    up: $('files-up'),
    refresh: $('files-refresh'),
    mkdir: $('files-mkdir'),
    input: $('files-input'),
    shortcuts: $('files-shortcuts'),
    list: $('files'),
    transfers: $('transfers'),
  },
  { toast },
);

// ------------------------------------------------------------------ estado da conexão
let devices = [];
let current = null;
let retries = 0;
let retryTimer = null;

function setOverlay(message, hint = '', showRetry = false) {
  $('overlay').hidden = !message;
  $('overlay-msg').textContent = message ?? '';
  $('overlay-hint').textContent = hint;
  $('retry').hidden = !showRetry;
}

function setPill(state, text) {
  const pill = $('conn-status');
  pill.dataset.state = state;
  pill.textContent = text;
}

function qualityOpts() {
  return store.get('quality', { maxSize: 1920, bitRate: 8000000, maxFps: 60, stayAwake: false, showTouches: false });
}

function startMirror() {
  clearTimeout(retryTimer);
  if (!current) return;
  setOverlay('Conectando…', 'Iniciando o servidor de espelhamento no aparelho.');
  mirror.connect(current, qualityOpts());
}

mirror.addEventListener('status', ({ detail }) => {
  if (detail.state === 'live') {
    retries = 0;
    setPill('live', 'Ao vivo');
    setOverlay('Aguardando primeiro quadro…', '');
  } else if (detail.state === 'busy') {
    setPill('busy', 'Conectando');
  } else if (detail.state === 'error') {
    setPill('error', 'Erro');
    setOverlay('Não foi possível espelhar', detail.message, true);
  }
});
mirror.addEventListener('frame', () => !$('overlay').hidden && setOverlay(null));
mirror.addEventListener('resize', fitCanvas);
mirror.addEventListener('stats', ({ detail }) => {
  $('stats').textContent = mirror.connected ? `${mirror.width}×${mirror.height} · ${detail.fps} fps · ${(detail.kbps / 1000).toFixed(1)} Mbps` : '';
});
mirror.addEventListener('notice', ({ detail }) => toast(detail, true));
mirror.addEventListener('clipboard', async ({ detail: text }) => {
  try {
    await navigator.clipboard.writeText(text);
    toast('Texto copiado do celular para o PC.');
  } catch {
    toast('O celular copiou um texto, mas o navegador bloqueou a área de transferência.');
  }
});
mirror.addEventListener('closed', () => {
  setPill('error', 'Desconectado');
  const dev = devices.find((d) => d.serial === current);
  if (dev?.state === 'device' && retries < 5) {
    // Queda transitória (ex.: tela girou e o encoder reiniciou com erro): tenta de novo.
    retries++;
    if ($('overlay').hidden) setOverlay('Reconectando…', '');
    retryTimer = setTimeout(startMirror, 1000 * retries);
  } else if ($('overlay-msg').textContent !== 'Não foi possível espelhar') {
    setOverlay('Espelhamento encerrado', dev ? '' : 'O aparelho foi desconectado.', Boolean(dev));
  }
});
$('retry').addEventListener('click', () => {
  retries = 0;
  startMirror();
});

// Mantém a proporção do vídeo ocupando o máximo do espaço disponível.
function fitCanvas() {
  const wrap = $('screen-wrap');
  const vw = canvas.width || 9;
  const vh = canvas.height || 16;
  const scale = Math.min(wrap.clientWidth / vw, wrap.clientHeight / vh);
  canvas.style.width = `${Math.floor(vw * scale)}px`;
  canvas.style.height = `${Math.floor(vh * scale)}px`;
}
new ResizeObserver(fitCanvas).observe($('screen-wrap'));

// ------------------------------------------------------------------ aparelhos
function deviceLabel(d) {
  const state = { device: '', unauthorized: ' — autorize no celular', offline: ' — offline' }[d.state] ?? ` — ${d.state}`;
  return `${d.model ?? d.serial} (${d.connection === 'wifi' ? 'Wi-Fi' : 'USB'})${state}`;
}

function renderDevices() {
  const sel = $('device-select');
  sel.replaceChildren(
    ...(devices.length
      ? devices.map((d) => Object.assign(document.createElement('option'), { value: d.serial, textContent: deviceLabel(d), disabled: d.state !== 'device' }))
      : [Object.assign(document.createElement('option'), { value: '', textContent: 'Nenhum celular conectado' })]),
  );
  const ready = devices.filter((d) => d.state === 'device');
  const keep = ready.find((d) => d.serial === current);
  const preferred = ready.find((d) => d.serial === store.get('serial', null));
  const next = keep ?? preferred ?? ready[0] ?? null;
  sel.value = next?.serial ?? '';
  if ((next?.serial ?? null) !== current) selectDevice(next?.serial ?? null);
  else if (!next) showNoDevice();
}

function showNoDevice() {
  const pending = devices.find((d) => d.state === 'unauthorized');
  setPill('idle', 'Sem conexão');
  if (pending) setOverlay('Autorize a depuração USB', 'Desbloqueie o celular e toque em "Permitir" no aviso de depuração USB.');
  else setOverlay('Aguardando celular…', 'Conecte o cabo USB com a depuração USB ativada (Configurações › Opções do desenvolvedor).');
}

function selectDevice(serial) {
  current = serial;
  retries = 0;
  mirror.disconnect();
  logcat.setDevice(serial);
  files.setDevice(serial);
  $('device-info').replaceChildren();
  $('stats').textContent = '';
  if (!serial) return showNoDevice();
  store.set('serial', serial);
  startMirror();
  loadInfo(serial);
}

async function loadInfo(serial) {
  try {
    const info = await fetch(`/api/info?serial=${encodeURIComponent(serial)}`).then((r) => r.json());
    if (serial !== current || info.error) return;
    const chips = [
      `${info.manufacturer} ${info.model}`.trim(),
      `Android ${info.android} (API ${info.sdk})`,
      `${info.width}×${info.height}`,
      info.battery !== null ? `Bateria ${info.battery}%${info.charging === 'carregando' ? ' ⚡' : ''}` : null,
    ].filter(Boolean);
    $('device-info').replaceChildren(...chips.map((t) => Object.assign(document.createElement('span'), { className: 'chip', textContent: t })));
  } catch {}
}
setInterval(() => current && loadInfo(current), 60000);

$('device-select').addEventListener('change', (ev) => selectDevice(ev.target.value || null));

function connectEvents() {
  const ws = new WebSocket(`ws://${location.host}/ws/events`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'devices') {
      devices = msg.devices;
      renderDevices();
    }
  };
  ws.onclose = () => {
    setPill('error', 'Servidor parado');
    setTimeout(connectEvents, 2000);
  };
}
connectEvents();

// ------------------------------------------------------------------ ferramentas
let notificationsOpen = false;
const actions = {
  back: () => mirror.back(),
  home: () => mirror.key(3),
  recents: () => mirror.key(187),
  power: () => mirror.key(26),
  volup: () => mirror.key(24),
  voldown: () => mirror.key(25),
  rotate: () => mirror.send({ t: 'rotate' }),
  notifications: () => {
    notificationsOpen = !notificationsOpen;
    mirror.send({ t: notificationsOpen ? 'notifications' : 'collapse' });
  },
  displayoff: (btn) => {
    const off = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(off));
    mirror.send({ t: 'displayPower', on: !off });
    toast(off ? 'Tela física apagada; o espelho continua ativo.' : 'Tela física religada.');
  },
  screenshot: async () => {
    const blob = await mirror.snapshot();
    if (!blob) return toast('Nenhum quadro para capturar.', true);
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  quality: () => {
    const form = $('quality-dialog').querySelector('form');
    const q = qualityOpts();
    for (const [k, v] of Object.entries(q)) {
      const el = form.elements[k];
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = Boolean(v);
      else el.value = String(v);
    }
    $('quality-dialog').showModal();
  },
};
for (const btn of document.querySelectorAll('[data-action]')) {
  btn.addEventListener('click', () => {
    actions[btn.dataset.action]?.(btn);
    if (btn.dataset.action !== 'quality') canvas.focus();
  });
}
$('quality-dialog').addEventListener('close', () => {
  if ($('quality-dialog').returnValue !== 'apply') return;
  const form = $('quality-dialog').querySelector('form');
  const q = {
    maxSize: Number(form.elements.maxSize.value),
    bitRate: Number(form.elements.bitRate.value),
    maxFps: Number(form.elements.maxFps.value),
    stayAwake: form.elements.stayAwake.checked,
    showTouches: form.elements.showTouches.checked,
  };
  store.set('quality', q);
  if (mirror.connected) {
    setOverlay('Aplicando…', '');
    mirror.restart(q);
  } else startMirror();
});

// ------------------------------------------------------------------ arrastar e soltar
let dragDepth = 0;
const hasFiles = (ev) => [...(ev.dataTransfer?.types ?? [])].includes('Files');
window.addEventListener('dragenter', (ev) => {
  if (!hasFiles(ev) || !current) return;
  dragDepth++;
  $('drop-target').textContent = `APK será instalado; outros arquivos vão para ${files.dir}`;
  $('drop').hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('drop').hidden = true;
  }
});
window.addEventListener('dragover', (ev) => hasFiles(ev) && ev.preventDefault());
window.addEventListener('drop', (ev) => {
  if (!hasFiles(ev)) return;
  ev.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  if (!current) return toast('Nenhum celular conectado.', true);
  files.upload([...ev.dataTransfer.files], { installApks: true });
});

// ------------------------------------------------------------------ aba de agentes
(async () => {
  try {
    const meta = await fetch('/api/meta').then((r) => r.json());
    const cli = `${meta.root}${meta.sep}src${meta.sep}cli.ts`;
    $('snippet-claude').textContent = `claude mcp add screen-mirror -- node "${cli}" mcp`;
    $('snippet-json').textContent = JSON.stringify({ mcpServers: { 'screen-mirror': { command: 'node', args: [cli, 'mcp'] } } }, null, 2);
    const base = location.origin;
    $('snippet-rest').textContent = [
      `curl ${base}/api/devices`,
      `curl -o tela.png ${base}/api/screenshot`,
      `curl "${base}/api/ui?format=text"`,
      `curl "${base}/api/logcat?pkg=com.exemplo.app&level=E&lines=200"`,
      `curl -X POST ${base}/api/input -H "content-type: application/json" -d "{\\"type\\":\\"tap\\",\\"x\\":540,\\"y\\":1200}"`,
    ].join('\n');
  } catch {}
})();
for (const b of document.querySelectorAll('[data-copy]')) {
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($(b.dataset.copy).textContent);
      toast('Copiado.');
    } catch {
      toast('Não foi possível copiar.', true);
    }
  });
}

// ------------------------------------------------------------------ pausa dos agentes de IA
async function refreshAgents(res) {
  try {
    const a = await (res ?? fetch('/api/agents')).then((r) => r.json());
    const btn = $('agents-btn');
    btn.dataset.paused = String(a.paused);
    btn.textContent = a.paused ? 'Agentes pausados' : `Agentes: ${a.mode === 'read-only' ? 'só leitura' : 'liberados'}`;
    btn.title = `${a.paused ? 'Liberar' : 'Pausar'} os agentes de IA (MCP). Regras: ${a.file}`;
  } catch {}
}
$('agents-btn').addEventListener('click', () => {
  const pause = $('agents-btn').dataset.paused !== 'true';
  refreshAgents(fetch(`/api/agents/pause?on=${pause ? 1 : 0}`, { method: 'POST' }));
  toast(pause ? 'Agentes de IA pausados: nenhuma ação deles chega ao celular.' : 'Agentes de IA liberados conforme as regras.');
});
refreshAgents();
setInterval(refreshAgents, 5000);
