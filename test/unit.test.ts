// Testes offline: parsers e serialização do protocolo (sem aparelho).
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { parseDevices } from '../src/core/adb.ts';
import { parseUiXml, interestingNodes, findNodes, formatUiNodes, resolveKeycode } from '../src/core/device.ts';
import { parseLine } from '../src/core/logcat.ts';
import { Control, ScrcpySession, POINTER_ID_FINGER } from '../src/core/scrcpy.ts';

test('parseDevices', () => {
  const d = parseDevices(
    'List of devices attached\nR58M123 device usb:1-1 product:a52 model:SM_A525M device:a52q transport_id:3\nemulator-5554 unauthorized transport_id:1\n192.168.0.5:5555 device model:Pixel_7\n\n',
  );
  assert.equal(d.length, 3);
  assert.deepEqual(d[0], { serial: 'R58M123', state: 'device', connection: 'usb', product: 'a52', model: 'SM A525M', device: 'a52q', transportId: '3' });
  assert.equal(d[1]!.state, 'unauthorized');
  assert.equal(d[2]!.connection, 'wifi');
});

test('parseUiXml + find', () => {
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.app" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]">
    <node index="0" text="Entrar &amp; continuar" resource-id="com.app:id/btn_login" class="android.widget.Button" package="com.app" content-desc="" clickable="true" enabled="true" bounds="[100,200][500,300]" />
    <node index="1" text="" resource-id="" class="android.widget.ImageView" package="com.app" content-desc="Configurações" clickable="true" enabled="true" bounds="[900,50][1000,150]" />
  </node></hierarchy>`;
  const nodes = parseUiXml(xml);
  assert.equal(nodes.length, 3);
  assert.equal(nodes[1]!.text, 'Entrar & continuar');
  assert.equal(nodes[1]!.depth, 1);
  assert.deepEqual(nodes[1]!.center, [300, 250]);
  const list = interestingNodes(nodes);
  assert.equal(list.length, 2);
  assert.equal(findNodes(list, { text: 'ENTRAR' })[0]!.id, 'com.app:id/btn_login');
  assert.equal(findNodes(list, { id: 'btn_login' }).length, 1);
  assert.equal(findNodes(list, { text: 'configuracoes' }).length, 1, 'ignora acentos e busca em content-desc');
  assert.match(formatUiNodes(list), /Button "Entrar & continuar" id=btn_login clickable center=\(300,250\)/);
});

test('logcat parseLine', () => {
  const e = parseLine('10-09 14:03:22.123  1234  1250 E AndroidRuntime: FATAL EXCEPTION: main');
  assert.deepEqual(e, { time: '10-09 14:03:22.123', pid: 1234, tid: 1250, level: 'E', tag: 'AndroidRuntime', msg: 'FATAL EXCEPTION: main' });
  assert.equal(parseLine('--------- beginning of crash'), null);
  assert.equal(parseLine('10-09 14:03:22.123  1234  1250 I chatty  : uid=1000 expire 3 lines')!.tag, 'chatty');
});

test('keycodes', () => {
  assert.equal(resolveKeycode('home'), 3);
  assert.equal(resolveKeycode('KEYCODE_BACK'), 4);
  assert.equal(resolveKeycode('66'), 66);
  assert.throws(() => resolveKeycode('nope'));
});

test('control messages match scrcpy v5 layout', () => {
  const touch = Control.touch(0, POINTER_ID_FINGER, { x: 100, y: 200, width: 1080, height: 2400 }, 1);
  assert.equal(touch.length, 32);
  assert.equal(touch.toString('hex'), '0200' + 'fffffffffffffffe' + '00000064' + '000000c8' + '0438' + '0960' + 'ffff' + '00000000' + '00000000');
  assert.equal(Control.keycode(1, 66, 0, 0x1000).toString('hex'), '00' + '01' + '00000042' + '00000000' + '00001000');
  const scroll = Control.scroll({ x: 1, y: 2, width: 3, height: 4 }, 0, -1);
  assert.equal(scroll.length, 21);
  assert.equal(scroll.readInt16BE(15), Math.round((-1 / 16) * 0x8000));
  const clip = Control.setClipboard(7n, 'olá', true);
  assert.equal(clip.toString('hex'), '09' + '0000000000000007' + '01' + '00000004' + Buffer.from('olá').toString('hex'));
  assert.equal(Control.text('x'.repeat(400)).readUInt32BE(1), 300, 'texto truncado em 300 bytes');
  assert.deepEqual([...Control.resetVideo()], [17]);
});

test('video demux (stream sintético, fragmentado byte a byte)', async () => {
  // Monta o que o servidor enviaria no socket de vídeo após o dummy byte.
  const name = Buffer.alloc(64);
  name.write('Pixel Teste');
  const codec = Buffer.from([0x68, 0x32, 0x36, 0x34]);
  const session = Buffer.alloc(12);
  session[0] = 0x80;
  session.writeUInt32BE(1080, 4);
  session.writeUInt32BE(2400, 8);
  const pkt = (flags: bigint, data: Buffer) => {
    const h = Buffer.alloc(12);
    h.writeBigUInt64BE(flags, 0);
    h.writeUInt32BE(data.length, 8);
    return Buffer.concat([h, data]);
  };
  const stream = Buffer.concat([
    name,
    codec,
    session,
    pkt(1n << 62n, Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f])),
    pkt((1n << 61n) | 1000n, Buffer.from('KEY')),
    pkt(2000n, Buffer.from('DELTA')),
  ]);

  const srv = net.createServer((sock) => {
    // Envia 1 byte por vez para exercitar a remontagem.
    const all = Buffer.concat([Buffer.from([0]), stream]);
    let i = 0;
    const tick = () => {
      if (i >= all.length) return;
      sock.write(all.subarray(i, i + 1));
      i++;
      setImmediate(tick);
    };
    tick();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as net.AddressInfo).port;

  const s = new ScrcpySession('fake', { control: false });
  const packets: any[] = [];
  s.on('packet', (p) => packets.push(p));
  const anyS = s as any;
  anyS.port = port;
  const first = await anyS.connectFirst();
  anyS.attachVideo(first.socket, first.queue);
  await new Promise((r) => setTimeout(r, 500));

  assert.equal(s.deviceName, 'Pixel Teste');
  assert.equal(s.codec, 'h264');
  assert.equal(s.width, 1080);
  assert.equal(s.height, 2400);
  assert.equal(packets.length, 3);
  assert.equal(packets[0].config, true);
  assert.equal(packets[1].key, true);
  assert.equal(packets[1].pts, 1000n);
  assert.equal(packets[1].data.toString(), 'KEY');
  assert.equal(packets[2].key, false);
  assert.equal(packets[2].data.toString(), 'DELTA');
  s.removeAllListeners('close');
  first.socket.destroy();
  srv.close();
});
