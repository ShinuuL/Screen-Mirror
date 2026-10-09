import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_POLICY, isBlockedApp, inputAllowedIn, pathAllowed, shellAllowed, type Policy } from '../src/core/policy.ts';

const p: Policy = { ...DEFAULT_POLICY };

test('apps bloqueados por nome e prefixo', () => {
  assert.equal(isBlockedApp('com.whatsapp', p), true);
  assert.equal(isBlockedApp('com.itau.empresas', p), true, 'prefixo com.itau*');
  assert.equal(isBlockedApp('com.whatsapp.extra', p), false, 'sem * exige nome exato');
  assert.equal(isBlockedApp('com.exemplo.meuapp', p), false);
  assert.match(inputAllowedIn('com.nu.production', p)!, /bloqueado/);
  assert.equal(inputAllowedIn('com.sec.android.app.launcher', p), null);
});

test('allowedApps restringe, mas a tela inicial continua liberada', () => {
  const only = { ...p, allowedApps: ['com.mastersys*'] };
  assert.equal(inputAllowedIn('com.mastersys.pdv', only), null);
  assert.equal(inputAllowedIn('com.sec.android.app.launcher', only), null);
  assert.match(inputAllowedIn('com.android.chrome', only)!, /allowedApps/);
});

test('pastas permitidas não escapam com .. nem por prefixo parecido', () => {
  assert.equal(pathAllowed('/sdcard/Download/a.pdf', p), true);
  assert.equal(pathAllowed('/storage/emulated/0/Download/x', p), true);
  assert.equal(pathAllowed('/sdcard/Download/../DCIM/foto.jpg', p), false);
  assert.equal(pathAllowed('/sdcard/DownloadX/a', p), false);
  assert.equal(pathAllowed('/sdcard/DCIM', p), false);
});

test('shell: desligado por padrão; com allowShell, só prefixos e sem encadeamento', () => {
  assert.match(shellAllowed('dumpsys battery', p)!, /desativado/);
  const on = { ...p, allowShell: true };
  assert.equal(shellAllowed('dumpsys battery', on), null);
  assert.match(shellAllowed('rm -rf /sdcard', on)!, /shellAllowPrefixes/);
  assert.match(shellAllowed('dumpsys battery; rm -rf /sdcard', on)!, /encadeamento/);
  assert.match(shellAllowed('getprop $(rm x)', on)!, /encadeamento/);
  assert.match(shellAllowed('pmx list', on)!, /shellAllowPrefixes/);
});
