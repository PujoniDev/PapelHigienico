# LimpaC — Gerenciador de armazenamento do Windows

App desktop (Electron + React + TypeScript) que mostra onde o espaço do disco está sendo usado, sugere limpezas de baixo risco e move arquivos pessoais para outro disco. Princípio central: **mostrar antes de agir**. Nada é excluído ou movido sem seleção e confirmação explícitas.

## Como rodar

Requer Windows 10/11 e Node.js 22.12 ou mais recente.

```bash
npm install
npm run dev        # abre o app com recarregamento automático
npm test           # testes (vitest)
npm run typecheck  # checagem de tipos do processo principal e da interface
npm run build      # gera out/
npm run dist:dir   # app empacotado em dist/win-unpacked/LimpaC.exe
npm run dist       # instalador NSIS em dist/
```

> Se o Electron abrir como Node puro (erro `Cannot read properties of undefined (reading 'setAppUserModelId')`), a variável `ELECTRON_RUN_AS_NODE=1` está definida no terminal. Alguns ambientes (extensões de IDE) a exportam. Remova-a antes de rodar: `Remove-Item Env:ELECTRON_RUN_AS_NODE`.

## Telas

| Tela | O que faz |
|---|---|
| Visão geral | Espaço livre, oportunidades estimadas, maiores pastas e outros discos |
| Analisar disco | Varredura com progresso e cancelamento; abas Pastas, Arquivos grandes e Tipos; busca; painel de detalhes |
| Limpeza | Temporários (mais de 7 dias), relatórios de erro, caches de navegadores e de shaders, Downloads (revisão manual), Lixeira |
| Mover arquivos | Copia, confere (SHA-256) e só depois, em etapa separada e opcional, apaga os originais; também desfaz |
| Aplicativos | Lista do Registro e abre o desinstalador oficial do próprio app |
| Histórico | Registro local de cada operação, com relatório |
| Configurações | Disco padrão, limite de “arquivo grande”, confirmações, tema, histórico |

## Arquitetura

```
src/
  shared/      tipos, contrato de IPC (api.ts), categorias e formatação
  preload/     ponte contextBridge: expõe só window.limpac
  main/
    index.ts           janela, segurança (sandbox, CSP, navegação bloqueada)
    ipc.ts             todos os canais, com validação zod e checagem do remetente
    policy.ts          o que é protegido e o que pode ser movido (só regras de caminho)
    scanner/           leitor de diretórios, varredura (em worker thread), índice em memória
    cleanup/           regras explícitas por categoria e execução com revalidação
    transfer/          cópia verificada, remoção de originais e desfazer
    apps.ts            aplicativos instalados (PowerShell, somente leitura)
    history.ts, settings.ts, volumes.ts, recycle-bin.ts
  renderer/    interface React (telas em screens/, componentes em components/)
```

- **Leitura rápida do disco:** o scanner usa `NtQueryDirectoryFile` via [koffi](https://koffi.dev) (FFI, sem compilação). Isso traz tamanho em disco, atributo oculto, tipo de link e ID do arquivo em lote, cerca de 10× mais rápido que `fs.readdir` + `fs.lstat`. Se o módulo nativo falhar, há um leitor de reserva em `fs` (mais lento e sem detectar ocultos).
- **Memória:** a varredura guarda pastas em arrays compactos e só os maiores arquivos de cada tipo; os arquivos de uma pasta específica são lidos na hora.
- **Links físicos** (comuns em `C:\Windows\WinSxS`) são contados uma vez só. Junções e links simbólicos nunca são seguidos.

## Decisões de segurança

- Nunca toca em `Windows`, `Program Files`, `ProgramData`, `AppData` (exceto nas pastas de cache/temporários listadas nas regras), pastas reservadas da raiz, pastas de jogos/aplicativos, `node_modules`, `.git` nem pastas iniciadas por ponto.
- A interface só envia seleções; o processo principal as confere com a lista que ele mesmo encontrou. Caminhos arbitrários vindos da interface são ignorados.
- Antes de cada exclusão: o arquivo precisa existir, ser um arquivo comum, ter o mesmo tamanho e data da revisão e continuar dentro da pasta da regra. Caches de navegador só são limpos com o navegador fechado (o app nunca encerra processos).
- Padrão é a Lixeira. Exclusão permanente é opção explícita e não existe para Downloads.
- Transferência: cópia para arquivo `.limpac-parcial`, conferência de tamanho e hash, renomeação sem sobrescrever. Os originais só saem depois, se o original não mudou e a cópia continua no destino.
- Sem privilégios de administrador, sem telemetria, sem rede.

## Diferenças em relação ao planejamento

- “Incluir arquivos ocultos” vem desligado, como planejado. Mas isso exclui `AppData`, `ProgramData` e o arquivo de paginação, que costumam ser boa parte do disco. O resumo mostra o que ficou de fora e oferece “Analisar novamente incluindo ocultos”.
- Mover arquivos para a Lixeira não libera espaço até ela ser esvaziada. O app avisa isso em todos os resultados.
- A remoção de originais oferece “Excluir permanentemente” como alternativa não padrão, porque arquivos grandes muitas vezes não cabem na Lixeira.
- Os resultados detalhados da varredura não são salvos entre sessões (só o resumo), para não guardar o inventário do disco.

## Testes

`src/main/__tests__/` cobre regras de caminho, varredura (junções, ocultos, links físicos, cancelamento), limpeza (idade, seleção, revalidação, apps abertos), transferência (conflitos, cancelamento, remoção, desfazer) e as chamadas nativas do Windows. As operações de arquivo rodam em pastas temporárias com uma Lixeira falsa.
