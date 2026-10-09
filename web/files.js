// Navegador de arquivos do aparelho com envio (upload), download, exclusão e criação de pastas.
import { icon } from './icons.js';

const SHORTCUTS = [
  ['Armazenamento', '/sdcard'],
  ['Download', '/sdcard/Download'],
  ['Câmera', '/sdcard/DCIM/Camera'],
  ['Capturas', '/sdcard/Pictures/Screenshots'],
  ['Documentos', '/sdcard/Documents'],
  ['Temporário (adb)', '/data/local/tmp'],
];

const fmtSize = (n) => {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
};
const fmtDate = (s) => (s ? new Date(s * 1000).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '');

export class FilesPanel {
  constructor(els, { toast }) {
    this.els = els;
    this.toast = toast;
    this.serial = null;
    this.path = els.path.value;
    this.loading = false;

    els.shortcuts.append(
      ...SHORTCUTS.map(([label, path]) => {
        const b = Object.assign(document.createElement('button'), { className: 'shortcut', textContent: label, title: path });
        b.addEventListener('click', () => this.open(path));
        return b;
      }),
    );
    els.path.addEventListener('keydown', (ev) => ev.key === 'Enter' && this.open(els.path.value.trim()));
    els.up.addEventListener('click', () => this.open(parent(this.path)));
    els.refresh.addEventListener('click', () => this.load());
    els.mkdir.addEventListener('click', () => this.mkdir());
    els.input.addEventListener('change', () => {
      this.upload([...els.input.files]);
      els.input.value = '';
    });
  }

  get dir() {
    return this.path;
  }

  setDevice(serial) {
    this.serial = serial;
    this.els.list.replaceChildren();
    if (serial) this.load();
  }

  open(path) {
    if (!path) return;
    this.path = path.length > 1 ? path.replace(/\/+$/, '') : path;
    this.els.path.value = this.path;
    this.load();
  }

  async load() {
    if (!this.serial) return;
    const list = this.els.list;
    list.setAttribute('aria-busy', 'true');
    try {
      const r = await api(`/api/files?serial=${enc(this.serial)}&path=${enc(this.path)}`);
      if (!r.entries.length) {
        list.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Pasta vazia. Arraste arquivos para cá para enviar.' }));
      } else {
        list.replaceChildren(...r.entries.map((e) => this.row(e)));
      }
    } catch (err) {
      list.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: err.message }));
    } finally {
      list.removeAttribute('aria-busy');
    }
  }

  row(e) {
    const isDir = e.type === 'dir';
    const div = document.createElement('div');
    div.className = `file-row${isDir ? ' dir' : ''}`;
    div.tabIndex = 0;
    div.setAttribute('role', 'row');
    const ic = icon(isDir ? 'folder' : 'file');
    const name = Object.assign(document.createElement('span'), { className: 'n', textContent: e.name, title: e.path });
    const size = Object.assign(document.createElement('span'), { className: 's', textContent: isDir ? '' : fmtSize(e.size) });
    const date = Object.assign(document.createElement('span'), { className: 'd', textContent: fmtDate(e.mtime) });
    const actions = Object.assign(document.createElement('span'), { className: 'a' });
    if (!isDir) {
      const dl = button('download', 'Baixar para o PC', () => this.download(e));
      actions.append(dl);
    }
    actions.append(button('trash', 'Excluir', () => this.remove(e)));
    div.append(ic, name, size, date, actions);
    const activate = () => (isDir ? this.open(e.path) : this.download(e));
    div.addEventListener('dblclick', activate);
    div.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') activate();
      if (ev.key === 'Delete') this.remove(e);
    });
    if (isDir) name.addEventListener('click', () => this.open(e.path));
    return div;
  }

  download(e) {
    const a = Object.assign(document.createElement('a'), {
      href: `/api/files/download?serial=${enc(this.serial)}&path=${enc(e.path)}`,
      download: e.name,
    });
    a.click();
  }

  async remove(e) {
    if (!confirm(`Excluir "${e.path}" do aparelho?${e.type === 'dir' ? '\n\nA pasta e todo o conteúdo serão apagados.' : ''}`)) return;
    try {
      await api(`/api/files/delete?serial=${enc(this.serial)}&path=${enc(e.path)}`, { method: 'POST' });
      this.toast(`Excluído: ${e.name}`);
      this.load();
    } catch (err) {
      this.toast(err.message, true);
    }
  }

  async mkdir() {
    const name = prompt('Nome da nova pasta:');
    if (!name) return;
    try {
      await api(`/api/files/mkdir?serial=${enc(this.serial)}&path=${enc(join(this.path, name))}`, { method: 'POST' });
      this.load();
    } catch (err) {
      this.toast(err.message, true);
    }
  }

  /** Envia arquivos para a pasta atual (ou instala, se for APK e install=true). */
  async upload(files, { installApks = false } = {}) {
    if (!this.serial || !files.length) return;
    for (const file of files) {
      const isApk = installApks && file.name.toLowerCase().endsWith('.apk');
      const url = isApk
        ? `/api/install?serial=${enc(this.serial)}&name=${enc(file.name)}`
        : `/api/files/upload?serial=${enc(this.serial)}&dir=${enc(this.path)}&name=${enc(file.name)}`;
      const item = document.createElement('div');
      item.className = 'transfer';
      const label = Object.assign(document.createElement('span'), { textContent: `${isApk ? 'Instalando' : 'Enviando'} ${file.name}` });
      const bar = Object.assign(document.createElement('progress'), { max: 1, value: 0 });
      item.append(label, bar);
      this.els.transfers.prepend(item);
      try {
        await xhrUpload(url, file, (p) => (bar.value = p));
        bar.removeAttribute('value'); // indeterminado enquanto o adb grava no aparelho
        label.textContent = isApk ? `Instalado: ${file.name}` : `Enviado: ${file.name} → ${this.path}`;
        bar.value = 1;
        this.toast(label.textContent);
      } catch (err) {
        item.classList.add('err');
        label.textContent = `Falhou: ${file.name} — ${err.message}`;
      }
      setTimeout(() => item.remove(), 8000);
    }
    this.load();
  }
}

function xhrUpload(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (ev) => ev.lengthComputable && onProgress(ev.loaded / ev.total);
    xhr.onload = () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.error || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Falha de rede'));
    xhr.send(file);
  });
}

async function api(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function button(name, title, onClick) {
  const b = Object.assign(document.createElement('button'), { className: 'icon-btn', title });
  b.append(icon(name));
  b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onClick();
  });
  return b;
}

const enc = encodeURIComponent;
const join = (dir, name) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);
const parent = (p) => (p.lastIndexOf('/') <= 0 ? '/' : p.slice(0, p.lastIndexOf('/')));
