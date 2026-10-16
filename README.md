# Prospecter

Disparador automático de mensagens de prospecção no WhatsApp, usando a [Evolution API](https://github.com/EvolutionAPI/evolution-api) em Docker.

- Vários números de prospecção (instâncias da Evolution), conectados por QR Code no painel
- Campanhas com mensagem personalizada (`{{nome}}`, colunas do CSV) e variações aleatórias (`{Oi|Olá}`)
- Importação de contatos por CSV (`,` ou `;`) ou lista de telefones, com deduplicação (inclusive com/sem o 9º dígito)
- Disparo com intervalo aleatório entre mensagens, limite diário por número, janela de horário e dias da semana
- Horários de envio sorteados a cada dia dentro da janela, para não criar um padrão fixo
- Validação antes de enviar: mensagem com variável vazia ou marcação quebrada (`{nome}`, `{{nome}`) não sai e fica como "Bloqueada"
- Verifica se o número tem WhatsApp antes de enviar e simula "digitando…"
- Registra respostas e descadastra automaticamente quem responde "SAIR", "PARAR" etc.

## Subindo

Pré-requisito: Docker Desktop.

```bash
cp .env.example .env      # troque senhas, EVOLUTION_API_KEY e WEBHOOK_TOKEN
docker compose up -d --build
```

Painel: http://localhost:3000 · Evolution API: http://localhost:8080 (header `apikey: $EVOLUTION_API_KEY`).

## Uso

1. **Números** → adicione um número (ex.: `vendas-01`) e leia o QR Code em WhatsApp → Aparelhos conectados.
2. **Campanhas** → crie a campanha, importe o CSV e use **Envio de teste** para conferir a mensagem.
3. Clique em **Iniciar**. O disparo só acontece dentro da janela de horário e respeita o limite diário de cada número.
4. Acompanhe enviadas, respostas e descadastros pelo painel.

Exemplo de CSV:

```csv
telefone;nome;empresa
11999998888;Maria Silva;Acme
21988887777;João Souza;Beta
```

## Integração com o WatchTower (MCP)

O Prospecter se conecta ao servidor MCP do WatchTower para puxar prospectos e registrar o que aconteceu:

1. No `.env`, defina `WATCHTOWER_MCP_URL` (e `PUBLIC_URL`, se o painel não estiver em `http://localhost:3000`) e rode `docker compose up -d app`.
2. Na aba **WatchTower**, clique em **Conectar ao WatchTower** e autorize no navegador (OAuth). Se o servidor aceitar um token fixo, use `WATCHTOWER_MCP_TOKEN` no lugar do OAuth.
3. Em uma campanha, use **Importar do WatchTower** e filtre por etapa, pasta, situação ou busca.
   - Com vários telefones, o celular é tentado primeiro e os outros servem de reserva.
   - Variáveis extras: `{{empresa}}`, `{{contato}}`, `{{cidade}}`, `{{pasta}}`, `{{documento}}`, `{{email}}`, `{{responsavel}}`.

O que é escrito de volta no WatchTower (configurável na aba):

- **Cada envio** vira uma anotação no histórico do prospecto, com o texto enviado.
- **Na primeira resposta**, o prospecto vai de "Novo" para "Iniciado atendimento" (as etapas são escolhidas no painel). Só move quem ainda está na etapa de origem; quem responde "SAIR" não muda de etapa.

As escritas passam por uma fila com novas tentativas: se o WatchTower estiver fora do ar, o disparo continua normalmente.

Para testar sem dados reais, use o servidor MCP falso:

```bash
node scripts/mock-watchtower.ts   # http://localhost:4100/mcp, token "mock-token"
# .env: WATCHTOWER_MCP_URL=http://host.docker.internal:4100/mcp  WATCHTOWER_MCP_TOKEN=mock-token
```

## Desenvolvimento

App no host, infraestrutura no Docker:

```bash
npm install
npm run infra:up   # postgres, redis e evolution
npm run dev        # http://localhost:3000, recarrega ao salvar
npm test
npm run typecheck
```

## Cuidados

Disparo em massa contra as políticas do WhatsApp pode levar ao **banimento do número**. Para reduzir o risco:

- use números "aquecidos" (com histórico de conversa) e comece com limites diários baixos (20–40)
- mantenha intervalos longos e variados e use spintax para não repetir o mesmo texto
- envie só para contatos com base legal para contato (LGPD) e sempre ofereça a opção de sair
