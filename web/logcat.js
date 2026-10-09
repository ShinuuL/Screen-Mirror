// Logcat ao vivo com filtros por nível, pacote (PID) e busca.

const LEVELS = ['V', 'D', 'I', 'W', 'E', 'F'];
const MAX_ENTRIES = 50000;
const TRIM_CHUNK = 5000;
const ROW_H = 20; // px — igual ao .log-row do CSS
const OVERSCAN = 10;

export class LogcatPanel {
  constructor(els) {
    this.els = els;
    this.entries = [];
    this.serial = null;
    this.ws = null;
    this.paused = false;
    this.pids = null; // Set de PIDs do pacote filtrado
    this.pidTimer = null;
    this.matcher = null;
    this.view = []; // entradas que passam nos filtros
    this.frame = 0;
    this.stick = true; // acompanhando o fim
    this.retryTimer = null;
    this.spacer = Object.assign(document.createElement('div'), { className: 'log-spacer' });
    this.window = Object.assign(document.createElement('div'), { className: 'log-window' });
    this.spacer.append(this.window);
    els.log.replaceChildren(this.spacer);
    els.log.addEventListener('scroll', () => {
      const log = els.log;
      this.stick = log.scrollHeight - log.scrollTop - log.clientHeight < ROW_H * 2;
      this.schedule();
    });
    // Ao reabrir a aba ou redimensionar, redesenha.
    new ResizeObserver(() => this.schedule()).observe(els.log);

    els.level.addEventListener('change', () => this.rerender());
    els.search.addEventListener('input', () => {
      this.matcher = buildMatcher(els.search.value);
      this.rerender();
    });
    els.pkg.addEventListener('change', () => this.updatePackage());
    els.pause.addEventListener('click', () => {
      this.paused = !this.paused;
      els.pause.setAttribute('aria-pressed', String(this.paused));
      els.pause.title = this.paused ? 'Retomar' : 'Pausar';
      if (!this.paused) this.rerender();
    });
    els.clear.addEventListener('click', () => {
      this.entries = [];
      this.rerender();
    });
    els.clearDevice.addEventListener('click', async () => {
      if (!this.serial) return;
      await fetch(`/api/logcat/clear?serial=${encodeURIComponent(this.serial)}`, { method: 'POST' });
      this.entries = [];
      this.rerender();
    });
    els.export.addEventListener('click', () => this.export());
  }

  setDevice(serial) {
    if (serial === this.serial) return;
    this.stop();
    this.serial = serial;
    this.entries = [];
    this.rerender();
    if (serial) {
      this.connect();
      this.updatePackage();
      this.loadPackages();
    }
  }

  connect() {
    const serial = this.serial;
    const ws = new WebSocket(`ws://${location.host}/ws/logcat?serial=${encodeURIComponent(serial)}&backlog=2000`);
    this.ws = ws;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'entries') this.add(msg.entries);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      // Reconecta enquanto o aparelho continuar selecionado.
      this.retryTimer = setTimeout(() => this.serial === serial && this.connect(), 3000);
    };
  }

  stop() {
    clearTimeout(this.retryTimer);
    clearInterval(this.pidTimer);
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
  }

  async loadPackages() {
    try {
      const r = await fetch(`/api/apps?serial=${encodeURIComponent(this.serial)}`).then((r) => r.json());
      this.els.packages.replaceChildren(...(r.packages ?? []).map((p) => Object.assign(document.createElement('option'), { value: p })));
    } catch {}
  }

  updatePackage() {
    clearInterval(this.pidTimer);
    const pkg = this.els.pkg.value.trim();
    if (!pkg || !this.serial) {
      this.pids = null;
      this.rerender();
      return;
    }
    const refresh = async () => {
      try {
        const r = await fetch(`/api/pid?serial=${encodeURIComponent(this.serial)}&pkg=${encodeURIComponent(pkg)}`).then((r) => r.json());
        const next = new Set(r.pids ?? []);
        const changed = !this.pids || next.size !== this.pids.size || [...next].some((p) => !this.pids.has(p));
        // Mantém PIDs antigos: o log de um processo que acabou de morrer (crash) continua visível.
        this.pids = new Set([...(this.pids ?? []), ...next]);
        if (changed) this.rerender();
      } catch {}
    };
    this.pids = new Set();
    refresh();
    // O app pode reiniciar com outro PID.
    this.pidTimer = setInterval(refresh, 2000);
  }

  passes(e) {
    const min = LEVELS.indexOf(this.els.level.value);
    if (LEVELS.indexOf(e[3]) < min) return false;
    if (this.pids && !this.pids.has(e[1])) return false;
    if (this.matcher && !this.matcher(`${e[4]}: ${e[5]}`)) return false;
    return true;
  }

  // Lista virtualizada: só as linhas visíveis existem no DOM. Com milhares de linhas reais no DOM,
  // cada lote forçava um layout de centenas de ms na thread principal — a mesma que desenha o vídeo.
  add(batch) {
    this.entries.push(...batch);
    if (this.entries.length > MAX_ENTRIES + TRIM_CHUNK) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
      this.view = this.entries.filter((e) => this.passes(e));
    } else {
      for (const e of batch) if (this.passes(e)) this.view.push(e);
    }
    if (!this.paused) this.schedule();
  }

  rerender() {
    this.view = this.entries.filter((e) => this.passes(e));
    this.stick = true;
    this.schedule();
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  paint() {
    const log = this.els.log;
    this.updateCount();
    // Aba oculta: nada a desenhar (o conteúdo é montado ao reabrir a aba).
    if (!log.offsetParent) return;
    this.spacer.style.height = `${this.view.length * ROW_H}px`;
    if (this.stick && this.els.follow.checked) log.scrollTop = log.scrollHeight;
    const first = Math.max(0, Math.floor(log.scrollTop / ROW_H) - OVERSCAN);
    const last = Math.min(this.view.length, Math.ceil((log.scrollTop + log.clientHeight) / ROW_H) + OVERSCAN);
    this.window.style.transform = `translateY(${first * ROW_H}px)`;
    const rows = [];
    for (let i = first; i < last; i++) rows.push(row(this.view[i]));
    this.window.replaceChildren(...rows);
  }

  updateCount() {
    this.els.count.textContent = `${this.view.length.toLocaleString('pt-BR')} exibidas · ${this.entries.length.toLocaleString('pt-BR')} recebidas${this.paused ? ' · pausado' : ''}`;
  }

  export() {
    const lines = this.entries.filter((e) => this.passes(e)).map((e) => `${e[0]} ${String(e[1]).padStart(5)} ${String(e[2]).padStart(5)} ${e[3]} ${e[4]}: ${e[5]}`);
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `logcat-${this.serial}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`,
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}

function buildMatcher(q) {
  q = q.trim();
  if (!q) return null;
  const m = q.match(/^\/(.+)\/([a-z]*)$/);
  if (m) {
    try {
      const re = new RegExp(m[1], m[2].includes('i') ? m[2] : m[2] + 'i');
      return (s) => re.test(s);
    } catch {}
  }
  const needle = q.toLowerCase();
  return (s) => s.toLowerCase().includes(needle);
}

function row(e) {
  const div = document.createElement('div');
  div.className = `log-row lv-${e[3]}`;
  const cell = (cls, text) => {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  };
  const tag = cell('g', e[4]);
  div.title = `${e[0]}  ${e[4]}: ${e[5]}`;
  div.append(cell('t', e[0].slice(6)), cell('p', e[1]), cell('l', e[3]), tag, cell('m', e[5]));
  return div;
}
