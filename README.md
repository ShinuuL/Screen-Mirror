# Screen Mirror

Espelhe e controle celulares Android no PC só conectando o cabo USB com a **depuração USB** ativada. Nenhum app precisa ser instalado no celular.

- **Painel local**: tela ao vivo em baixa latência (H.264 por hardware), controle por mouse e teclado, logcat em tempo real com filtros, gerenciador de arquivos e envio por arrastar e soltar (APK é instalado).
- **Agentes de IA (MCP)**: o agente vê a tela (imagem ou árvore de elementos), toca, digita, lê logs, troca arquivos e roda comandos.
- **API HTTP local**: os mesmos recursos para scripts e ferramentas sem MCP.

## Requisitos

| Item | Versão |
|---|---|
| Node.js | 22.18 ou superior (executa TypeScript nativamente, sem build) |
| Android platform-tools (`adb`) | opcional. Usa o do Android Studio/`PATH`/`ADB_PATH` se existir; senão o `npm install` baixa o oficial do Google |
| Celular | Android 5+ (espelhamento); Android 7+ recomendado. Testado no Android 15 |
| Navegador | Edge ou Chrome (usa WebCodecs) |

## Instalação

```powershell
npm install        # baixa o scrcpy-server v5.0.1 (SHA-256 conferido) e, se faltar, o adb
npm run doctor     # verifica Node, adb, scrcpy-server e aparelhos conectados
```

No celular: **Configurações › Sobre o telefone** › toque 7× em "Número da versão" › **Opções do desenvolvedor › Depuração USB**. Ao conectar o cabo, aceite o aviso "Permitir depuração USB" (marque "Sempre permitir").

## Uso

### Painel

Dê dois cliques em `Screen Mirror.cmd` ou rode:

```powershell
npm start          # abre o painel numa janela própria (Edge/Chrome em modo app)
npm run serve      # só o servidor: http://127.0.0.1:7380
```

| No espelho | Ação no celular |
|---|---|
| Clique / arrastar | Toque / deslizar |
| Botão direito | Voltar (liga a tela se estiver apagada) |
| Botão do meio | Início |
| Roda do mouse | Rolar |
| Digitar (com o espelho em foco) | Texto, Enter, Backspace, setas, Tab, Esc |
| `Ctrl+V` | Cola o texto da área de transferência do PC |
| Copiar no celular | Vai automaticamente para a área de transferência do PC |
| Arrastar arquivos para a janela | `.apk` é instalado; os demais vão para a pasta aberta na aba Arquivos |

A barra lateral tem energia, volume, girar, notificações, captura (PNG), apagar a tela física mantendo o espelho e qualidade do vídeo (resolução, taxa de bits, FPS).

Vários aparelhos podem ficar conectados ao mesmo tempo; escolha qual espelhar no seletor do topo. O painel reconecta sozinho quando o cabo é recolocado.

### Agentes de IA (MCP)

Dentro desta pasta, o `.mcp.json` já registra o servidor para o Claude Code. Para usar em qualquer pasta, rode uma vez em cada máquina:

```powershell
npm run mcp-install
```

Ele registra o servidor no Claude Code do usuário atual com os caminhos daquela máquina. Sem Claude Code, imprime o JSON pronto para outros clientes MCP. A aba **Agentes de IA** do painel também mostra os comandos com os caminhos corretos.

O servidor MCP é independente do painel: funciona com ou sem ele aberto.

| Ferramenta | Para quê |
|---|---|
| `screenshot` | Imagem da tela (reduzida para economizar tokens; informa o fator de escala das coordenadas) |
| `ui_tree` | Elementos da tela com texto, id, se é clicável e coordenadas. Mais preciso e barato que a imagem |
| `tap`, `tap_element`, `swipe`, `long_press` | Toques por coordenada ou por texto/id/descrição do elemento |
| `type_text` | Digita no campo focado; aceita acentos e emoji (cola de uma vez e restaura a área de transferência) |
| `press_key` | `HOME`, `BACK`, `ENTER`, `APP_SWITCH`, `POWER`, volume… ou keycode numérico |
| `wait_for` | Espera um elemento aparecer ou sumir |
| `logcat`, `clear_logcat` | Logs por pacote (PID), nível mínimo, tag, regex; `buffer=crash` para crashes |
| `list_files`, `pull_file`, `push_file` | Transferência de arquivos |
| `list_installables`, `install_apk` | APKs em `dist/` e instalação (com sua confirmação) |
| `open_app`, `stop_app`, `list_apps` | Gerenciar apps |
| `device_info` | Modelo, Android, resolução, bateria e app em primeiro plano |
| `shell` | Comando no shell do Android (usuário `shell`, sem root) |

Exemplo de pedido ao agente: *"Abra o app com.exemplo, faça login com o usuário teste, e se der erro me mostre o logcat do app com nível E."*

### Regras para agentes

Toda ação de um agente via MCP passa por regras definidas em `~/.screen-mirror/policy.json`, que é criado com padrões seguros na primeira execução. O arquivo é relido a cada ação, então uma edição vale na hora. Se ele estiver inválido, os agentes ficam em somente leitura.

| Regra | Padrão | Efeito |
|---|---|---|
| `paused` | `false` | Botão de emergência: bloqueia tudo. Também pelo botão **Agentes** no topo do painel ou `npm run agents:pause` / `agents:resume` |
| `mode` | `interactive` | `read-only` (só ver), `interactive` (ver, tocar, digitar, abrir apps) ou `full` (também ações de sistema liberadas abaixo) |
| `blockedApps` | bancos, carteiras, WhatsApp/Telegram, e-mail, redes sociais, galeria/fotos, Play Store, Configurações, gerenciadores de senha | O agente não abre esses apps, não vê a tela deles (screenshot/árvore) e não toca neles. Aceita prefixo com `*` |
| `allowedApps` | vazio | Se preenchido, toques e digitação só nesses apps (ex.: `["com.mastersys*"]`), além da tela inicial |
| `allowShell` / `shellAllowPrefixes` | desligado / `dumpsys`, `getprop`, `pm list`… | Comandos só com esses prefixos e sem `;`, `&&`, `\|`, `$()` ou redirecionamentos |
| `allowInstall` / `installRequiresConfirmation` | `true` / `true` | O agente só instala APKs da pasta **`dist/`** do projeto (`list_installables` mostra quais), e cada instalação abre uma janela do sistema no PC pedindo sua aprovação; sem **Sim** em 2 minutos, é recusada. Caminhos fora de `dist/` são recusados. Sem confirmação, exige `mode: "full"` |
| `allowStopApp`, `allowPushFiles`, `allowPullFiles` | `true` | Encerrar apps e copiar arquivos |
| `filePaths` | `/sdcard/Download`, `/data/local/tmp` | Únicas pastas que o agente lista, lê ou grava |
| `maxActionsPerMinute` | `60` | Limite de toques, teclas e digitação |
| `audit` | `true` | Cada ação (permitida ou bloqueada) vai para `~/.screen-mirror/audit.log`; o texto digitado não é gravado, só o tamanho |

Voltar, Início e Recentes são sempre permitidos, para o agente conseguir sair de um app protegido. `npm run policy` mostra o resumo e o caminho dos arquivos.

As regras valem para o MCP. Um agente que também tenha acesso ao terminal pode chamar o `adb` diretamente; para impedir isso no Claude Code, adicione `"Bash(adb:*)"` em `permissions.deny` do `~/.claude/settings.json`.

### API HTTP

Disponível enquanto o painel estiver rodando (apenas em `127.0.0.1`). `serial` é opcional quando há um único aparelho.

```bash
curl http://127.0.0.1:7380/api/devices
curl -o tela.png http://127.0.0.1:7380/api/screenshot              # PNG nativo
curl -o tela.jpg "http://127.0.0.1:7380/api/screenshot?maxSize=1280" # reduzido
curl "http://127.0.0.1:7380/api/ui?format=text"
curl "http://127.0.0.1:7380/api/logcat?pkg=com.exemplo&level=E&lines=200"
curl -X POST http://127.0.0.1:7380/api/input -H "content-type: application/json" -d "{\"type\":\"tap\",\"x\":540,\"y\":1200}"
curl -X POST --data-binary @arquivo.pdf "http://127.0.0.1:7380/api/files/upload?dir=/sdcard/Download&name=arquivo.pdf"
curl -o saida.pdf "http://127.0.0.1:7380/api/files/download?path=/sdcard/Download/arquivo.pdf"
```

Rotas: `GET /api/devices | info | screenshot | ui | logcat | pid | apps | current-app | files | files/download` e `POST /api/input | logcat/clear | files/upload | files/delete | files/mkdir | install`. `/api/input` aceita `tap`, `swipe`, `longPress`, `key` e `text`.

## Latência

O toque vai direto do navegador ao celular: mouse → WebSocket → socket TCP sem buffer (Nagle desligado) → scrcpy → injeção de evento no Android. O vídeo volta em H.264 codificado por hardware no celular e é decodificado pela GPU do PC (WebCodecs) e desenhado assim que chega, sem esperar o próximo vsync. Se o PC ficar para trás, quadros atrasados são descartados em vez de acumular atraso.

Em celular físico via USB, o atraso típico dessa arquitetura (a mesma do scrcpy) fica em algumas dezenas de milissegundos. Para reduzir ainda mais, em **Qualidade**:
- **1024 ou 1600 px**: menos trabalho de codificação no celular. É o ajuste que mais ajuda em aparelhos simples.
- **60 FPS**: mantenha.
- Use cabo USB direto no PC, sem hub, e de preferência USB 3.

A barra sob o espelho mostra resolução, FPS e taxa atual. Com a tela parada o FPS cai a 0; é normal, porque o celular só envia quadros quando algo muda.

## Configuração

| Variável | Padrão | Uso |
|---|---|---|
| `SM_PORT` | `7380` | Porta do painel (ou `--port N`) |
| `SM_HOST` | `127.0.0.1` | Interface de escuta. **Não exponha na rede**: não há autenticação |
| `ADB_PATH` | detectado | Caminho do `adb` |

## Como funciona

```
Celular (USB, depuração ativa)
  ├─ adb shell / exec-out ─────── screencap, uiautomator, input, logcat, pm, am, arquivos
  └─ scrcpy-server (app_process) ─ H.264 + canal de controle, via adb forward
        │
PC: Node.js (src/)
  ├─ core/adb.ts       execução do adb e detecção de aparelhos (track-devices)
  ├─ core/scrcpy.ts    cliente do protocolo scrcpy v5 (vídeo, toque, teclado, área de transferência)
  ├─ core/device.ts    captura, árvore de UI, entrada, apps, arquivos
  ├─ core/logcat.ts    consulta e stream do logcat
  ├─ server/           HTTP + WebSocket: uma sessão de vídeo por aparelho, compartilhada entre janelas
  └─ mcp/server.ts     servidor MCP (stdio)
        │
web/  painel: WebCodecs decodifica o H.264 no navegador, sem plugins
```

O `scrcpy-server` (projeto [Genymobile/scrcpy](https://github.com/Genymobile/scrcpy), licença Apache 2.0) roda temporariamente via `app_process` e não deixa nada instalado: cada sessão usa uma cópia descartável em `/data/local/tmp`, e as configurações alteradas (mostrar toques, manter acordado) são restauradas ao final.

## Segurança

- O servidor escuta só em `127.0.0.1` e recusa requisições com `Host`/`Origin` diferentes. Isso impede que páginas abertas no navegador ou DNS rebinding controlem o celular.
- A ferramenta `shell` do MCP executa comandos arbitrários como usuário `shell`. Conceda o servidor MCP só a agentes de confiança e revise as ações em aparelhos com dados reais de clientes (LGPD).
- A exclusão de arquivos recusa raízes de armazenamento (`/`, `/sdcard`).
- Desative a depuração USB quando o aparelho não estiver em uso para desenvolvimento.

## Solução de problemas

| Sintoma | Causa provável / solução |
|---|---|
| Aparelho "não autorizado" | Desbloqueie o celular e aceite o aviso de depuração. Se não aparecer: Opções do desenvolvedor › Revogar autorizações e reconecte |
| Aparelho não aparece | Cabo só de carga, driver USB do fabricante (Windows) ou modo USB "só carregar". Rode `npm run doctor` |
| Tela preta em um app específico | O app usa `FLAG_SECURE` (bancos, DRM). O Android bloqueia a captura; não há contorno |
| `ui_tree` falha | A tela tem animação contínua (vídeo, jogos). Use `screenshot` |
| Vídeo travando | Reduza a resolução ou a taxa de bits em Qualidade; prefira cabo USB 3 |
| Porta em uso | Já há um painel aberto: `npm start` reabre a janela existente |

## Desenvolvimento

```powershell
npm test           # testes offline: parsers, serialização do protocolo, demux do vídeo
npm run typecheck
```

Limitações atuais: sem áudio, sem gravação de vídeo e sem conexão por Wi-Fi pelo painel. Aparelhos pareados via `adb connect`/`adb pair` aparecem normalmente, mas o pareamento é feito pela linha de comando.
