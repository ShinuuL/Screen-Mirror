// Recebe o H.264 do servidor via WebSocket, decodifica com WebCodecs (aceleração por hardware)
// e envia toques/teclas de volta como comandos JSON.

const KIND_CONFIG = 0;
const KIND_KEY = 1;
const ACTION = { DOWN: 0, UP: 1, MOVE: 2 };

// KeyboardEvent.code -> keycode Android
const KEYMAP = {
  Enter: 66, NumpadEnter: 66, Backspace: 67, Delete: 112, Tab: 61, Escape: 111,
  ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
  Home: 122, End: 123, PageUp: 92, PageDown: 93, Insert: 124, Space: 62,
};
for (let i = 0; i < 26; i++) KEYMAP['Key' + String.fromCharCode(65 + i)] = 29 + i;
for (let i = 0; i < 10; i++) KEYMAP['Digit' + i] = 7 + i;

const META = { shift: 0x41, ctrl: 0x3000, alt: 0x12 };

/** Extrai "avc1.PPCCLL" do SPS (NAL tipo 7) de um pacote Annex B. */
function codecFromConfig(data) {
  for (let i = 0; i + 4 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && (data[i + 2] === 1 || (data[i + 2] === 0 && data[i + 3] === 1))) {
      const start = data[i + 2] === 1 ? i + 3 : i + 4;
      if ((data[start] & 0x1f) === 7) {
        const hex = (b) => b.toString(16).padStart(2, '0');
        return `avc1.${hex(data[start + 1])}${hex(data[start + 2])}${hex(data[start + 3])}`;
      }
    }
  }
  return 'avc1.42e01f';
}

export class Mirror extends EventTarget {
  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.ws = null;
    this.decoder = null;
    this.config = null;
    this.needConfigure = false;
    this.waitingKey = true;
    this.width = 0; // tamanho do vídeo informado pelo servidor (usado nos eventos de toque)
    this.height = 0;
    this.pendingFrame = null;
    this.frames = 0;
    this.bytes = 0;
    this.pointers = new Map();
    this.serial = null;
    this.opts = {};
    this.statsTimer = null;
    // GPU quando a máquina tiver decodificador H.264 por hardware; senão software (ainda rápido).
    this.hwAccel = 'no-preference';
    window.VideoDecoder?.isConfigSupported({ codec: 'avc1.42e01f', hardwareAcceleration: 'prefer-hardware' })
      .then((s) => s.supported && (this.hwAccel = 'prefer-hardware'))
      .catch(() => {});
    this.bindInput();
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(serial, opts = {}) {
    this.disconnect();
    this.serial = serial;
    this.opts = opts;
    const params = new URLSearchParams({ serial });
    for (const [k, v] of Object.entries(opts)) if (v !== undefined && v !== null && v !== false) params.set(k, v === true ? '1' : String(v));
    const ws = new WebSocket(`ws://${location.host}/ws/mirror?${params}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.emit('status', { state: 'busy', message: 'Iniciando espelhamento…' });
    ws.onmessage = (ev) => (typeof ev.data === 'string' ? this.onJson(JSON.parse(ev.data)) : this.onPacket(new Uint8Array(ev.data)));
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.resetDecoder();
      this.emit('closed', { code: ev.code, reason: ev.reason });
    };
    this.statsTimer = setInterval(() => {
      this.emit('stats', { fps: this.frames, kbps: Math.round((this.bytes * 8) / 1000) });
      this.frames = 0;
      this.bytes = 0;
    }, 1000);
  }

  disconnect() {
    clearInterval(this.statsTimer);
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
    this.resetDecoder();
  }

  restart(opts) {
    this.opts = { ...this.opts, ...opts };
    this.send({ t: 'restart', opts });
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  send(msg) {
    if (this.connected) this.ws.send(JSON.stringify(msg));
  }

  onJson(msg) {
    switch (msg.type) {
      case 'init':
        this.width = msg.width;
        this.height = msg.height;
        this.resetDecoder();
        this.emit('status', { state: 'live', message: msg.deviceName, init: msg });
        break;
      case 'size':
        this.width = msg.width;
        this.height = msg.height;
        break;
      case 'clipboard':
        this.emit('clipboard', msg.text);
        break;
      case 'error':
      case 'closed':
        this.emit('status', { state: 'error', message: msg.message || msg.reason });
        break;
      case 'warn':
        console.warn(msg.message);
        break;
    }
  }

  // ------------------------------------------------------------ vídeo

  resetDecoder() {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
    this.needConfigure = Boolean(this.config);
    this.waitingKey = true;
  }

  ensureDecoder() {
    if (this.decoder && this.decoder.state !== 'closed') return this.decoder;
    if (!('VideoDecoder' in window)) {
      this.emit('status', { state: 'error', message: 'Este navegador não suporta WebCodecs. Use Edge ou Chrome atualizados.' });
      return null;
    }
    this.decoder = new VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: (err) => {
        console.error('Decoder:', err);
        this.resetDecoder();
        this.send({ t: 'reset' }); // pede novo keyframe
      },
    });
    return this.decoder;
  }

  onPacket(buf) {
    const kind = buf[0];
    const pts = new DataView(buf.buffer, buf.byteOffset + 1, 8).getFloat64(0);
    const data = buf.subarray(9);
    this.bytes += buf.length;

    if (kind === KIND_CONFIG) {
      this.config = data;
      this.needConfigure = true;
      return;
    }
    const isKey = kind === KIND_KEY;
    if (!isKey && this.waitingKey) return;

    const decoder = this.ensureDecoder();
    if (!decoder) return;
    let payload = data;
    if (isKey && this.needConfigure && this.config) {
      decoder.configure({ codec: codecFromConfig(this.config), optimizeForLatency: true, hardwareAcceleration: this.hwAccel });
      payload = new Uint8Array(this.config.length + data.length);
      payload.set(this.config, 0);
      payload.set(data, this.config.length);
      this.needConfigure = false;
    }
    if (decoder.state !== 'configured') return;
    // Decodificadores por hardware seguram alguns quadros por natureza; só um acúmulo grande
    // (thread travada por muito tempo) justifica descartar e pedir um keyframe novo.
    if (!isKey && decoder.decodeQueueSize > 30) {
      this.waitingKey = true;
      this.send({ t: 'reset' });
      return;
    }
    this.waitingKey = false;
    decoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: pts, data: payload }));
  }

  onFrame(frame) {
    this.frames++;
    // Desenha assim que o quadro sai do decodificador (canvas "desynchronized" = sem esperar o vsync).
    if (this.pendingFrame) this.pendingFrame.close();
    this.pendingFrame = frame;
    this.draw();
  }

  draw() {
    const frame = this.pendingFrame;
    this.pendingFrame = null;
    if (!frame) return;
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.emit('resize', { width: w, height: h });
    }
    this.ctx.drawImage(frame, 0, 0, w, h);
    frame.close();
    this.emit('frame');
  }

  // ------------------------------------------------------------ entrada

  toVideo(ev) {
    const r = this.canvas.getBoundingClientRect();
    const w = this.width || this.canvas.width;
    const h = this.height || this.canvas.height;
    return {
      x: Math.max(0, Math.min(w - 1, ((ev.clientX - r.left) / r.width) * w)),
      y: Math.max(0, Math.min(h - 1, ((ev.clientY - r.top) / r.height) * h)),
      w,
      h,
    };
  }

  key(code, metaState = 0) {
    this.send({ t: 'key', a: ACTION.DOWN, code, meta: metaState });
    this.send({ t: 'key', a: ACTION.UP, code, meta: metaState });
  }

  back() {
    this.send({ t: 'back', a: ACTION.DOWN });
    this.send({ t: 'back', a: ACTION.UP });
  }

  bindInput() {
    const c = this.canvas;
    // `pos` fornece clientX/Y (pode ser um evento agrupado); `ev` identifica o ponteiro.
    const touch = (ev, action, pos = ev) => {
      const p = this.toVideo(pos);
      // Mouse vira "dedo"; telas touch do PC mantêm o pointerId (multitoque).
      const id = ev.pointerType === 'touch' ? ev.pointerId : 'finger';
      this.send({ t: 'touch', a: action, id, x: p.x, y: p.y, w: p.w, h: p.h, p: action === ACTION.UP ? 0 : 1 });
    };

    c.addEventListener('pointerdown', (ev) => {
      if (!this.connected) return;
      c.focus();
      if (ev.button === 2) return this.back();
      if (ev.button === 1) return this.key(3);
      if (ev.button !== 0) return;
      ev.preventDefault();
      c.setPointerCapture(ev.pointerId);
      this.pointers.set(ev.pointerId, true);
      touch(ev, ACTION.DOWN);
    });
    c.addEventListener('pointermove', (ev) => {
      if (!this.pointers.has(ev.pointerId)) return;
      // Eventos agrupados dão traçado mais suave em gestos rápidos.
      const events = ev.getCoalescedEvents?.() ?? [];
      for (const e of events.length ? events : [ev]) touch(ev, ACTION.MOVE, e);
    });
    const end = (ev) => {
      if (!this.pointers.delete(ev.pointerId)) return;
      touch(ev, ACTION.UP);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('contextmenu', (ev) => ev.preventDefault());
    c.addEventListener(
      'wheel',
      (ev) => {
        if (!this.connected) return;
        ev.preventDefault();
        const scale = ev.deltaMode === 1 ? 33 : ev.deltaMode === 2 ? 400 : 1;
        const p = this.toVideo(ev);
        this.send({ t: 'scroll', x: p.x, y: p.y, w: p.w, h: p.h, hs: (-ev.deltaX * scale) / 100, vs: (-ev.deltaY * scale) / 100 });
      },
      { passive: false },
    );

    c.addEventListener('keydown', (ev) => {
      if (!this.connected) return;
      const ctrl = ev.ctrlKey || ev.metaKey;
      if (ctrl && ev.code === 'KeyV') {
        ev.preventDefault();
        navigator.clipboard
          .readText()
          .then((text) => text && this.send({ t: 'paste', text }))
          .catch(() => this.emit('notice', 'Sem permissão para ler a área de transferência do PC.'));
        return;
      }
      const meta = (ev.shiftKey ? META.shift : 0) | (ctrl ? META.ctrl : 0) | (ev.altKey ? META.alt : 0);
      if (ev.key.length === 1 && !ctrl && !ev.altKey) {
        ev.preventDefault();
        this.send({ t: 'text', text: ev.key });
        return;
      }
      const code = KEYMAP[ev.code];
      if (code === undefined) return;
      ev.preventDefault();
      this.send({ t: 'key', a: ACTION.DOWN, code, repeat: ev.repeat ? 1 : 0, meta });
    });
    c.addEventListener('keyup', (ev) => {
      if (!this.connected) return;
      const ctrl = ev.ctrlKey || ev.metaKey;
      if (ev.key.length === 1 && !ctrl && !ev.altKey) return;
      const code = KEYMAP[ev.code];
      if (code === undefined) return;
      ev.preventDefault();
      const meta = (ev.shiftKey ? META.shift : 0) | (ctrl ? META.ctrl : 0) | (ev.altKey ? META.alt : 0);
      this.send({ t: 'key', a: ACTION.UP, code, meta });
    });
  }

  /** PNG do quadro atual, sem round-trip ao aparelho. */
  snapshot() {
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'));
  }
}
