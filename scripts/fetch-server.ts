// npm install / npm run setup: obtém adb (se faltar) e scrcpy-server. Falhas não derrubam a instalação:
// screenshot, logcat, arquivos e MCP funcionam sem o espelhamento ao vivo.
import { ensureAdb, ensureScrcpyServer } from '../src/core/setup.ts';
import { SCRCPY_SERVER_LOCAL, SCRCPY_SERVER_URL } from '../src/config.ts';

try {
  await ensureAdb();
} catch (err) {
  console.error(`Falha ao baixar o adb: ${(err as Error).message}. Instale o Android platform-tools ou defina ADB_PATH.`);
}
try {
  await ensureScrcpyServer();
  console.log('scrcpy-server OK.');
} catch (err) {
  console.error(`Falha ao obter o scrcpy-server: ${(err as Error).message}`);
  console.error(`Baixe manualmente de ${SCRCPY_SERVER_URL} e salve em ${SCRCPY_SERVER_LOCAL}`);
}
