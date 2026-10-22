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
- Números em Coexistência (Coex) pela Cloud API da Meta: o número continua no WhatsApp Business do celular, as campanhas saem por template aprovado e as conversas seguem no app

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
- **A cada envio**, o prospecto vai de "Novo" para "Iniciado atendimento" (etapas e gatilho, envio ou primeira resposta, escolhidos no painel). Só move quem ainda está na etapa de origem, então quem já avançou no funil nunca volta.

As escritas passam por uma fila com novas tentativas: se o WatchTower estiver fora do ar, o disparo continua normalmente.

Para testar sem dados reais, use o servidor MCP falso:

```bash
node scripts/mock-watchtower.ts   # http://localhost:4100/mcp, token "mock-token"
# .env: WATCHTOWER_MCP_URL=http://host.docker.internal:4100/mcp  WATCHTOWER_MCP_TOKEN=mock-token
```

## Banco externo (Neon) e conversas do WhatsApp

Por padrão o Prospecter usa o Postgres do compose. Para concentrar os dados num Postgres externo (ex.: Neon), defina `APP_DATABASE_URL` no `.env`: ela tem prioridade sobre `DATABASE_URL`, tanto no host quanto no compose. A Evolution continua usando o Postgres do compose.

Para levar os dados existentes para o banco novo, com o app parado:

```bash
docker compose stop app
node scripts/copy-db.ts <url-origem> <url-destino>   # aplica as migrações no destino e faz upsert de tudo, mantendo os ids
docker compose up -d app
```

O script pode ser rodado de novo: o que já existe no destino é atualizado, nada é duplicado.

O app também guarda as conversas das instâncias do WhatsApp (`wa_contacts` e `wa_messages`), inclusive o que foi falado direto pelo celular, e liga cada conversa ao contato do Prospecter com o mesmo telefone. A carga completa roda ao iniciar e a cada 30 minutos; as mensagens novas chegam na hora pelo webhook. Para forçar uma carga, use `POST /api/whatsapp/sync`. `GET /api/whatsapp/conversations` lista uma linha por número, com a empresa e as contagens de enviadas e recebidas (`?q=` filtra), e `GET /api/whatsapp/messages?key=` traz as mensagens de uma conversa. No painel, tudo isso fica na aba **Conversas**.

### Leitura das conversas por outros sistemas

O schema `leitura` expõe as conversas para consulta direta no banco, sem tocar nas tabelas internas. Quem lê usa o role `prospecter_leitura`, que só enxerga esse schema e conecta em modo somente leitura.

| View | Uma linha por | Colunas principais |
| --- | --- | --- |
| `leitura.numeros` | número do Prospecter | `instancia`, `canal` (`evolution`/`cloud`), `numero` |
| `leitura.conversas` | número vinculado + contato | `numero_vinculado`, `telefone_contato`, `contato`, `empresa`, `wt_prospect_id`, `enviadas`, `enviadas_pelo_celular`, `recebidas`, `ultima_mensagem_em`, `ultimo_texto` |
| `leitura.mensagens` | mensagem | `numero_vinculado`, `conversa`, `telefone_contato`, `direcao` (`enviada`/`recebida`), `origem`, `texto`, `enviada_em`, `wt_prospect_id` |

```bash
node --env-file=.env scripts/create-reader.ts "$APP_DATABASE_URL"   # cria o role (ou troca a senha) e grava a URL em .env.leitura
```

```sql
-- Conversas de um número, mais recentes primeiro
SELECT contato, empresa, telefone_contato, enviadas, recebidas, ultima_mensagem_em, ultimo_texto
FROM conversas WHERE numero_vinculado = '5551926343407' ORDER BY ultima_mensagem_em DESC;

-- Histórico de um prospecto do WatchTower
SELECT numero_vinculado, direcao, origem, texto, enviada_em
FROM mensagens WHERE wt_prospect_id = '<uuid>' ORDER BY enviada_em;
```

O `.env.leitura` não vai para o git. Depois de copiar o banco com `scripts/copy-db.ts`, rode o `create-reader.ts` também no destino: o role não é copiado.

## Números Coex (Cloud API da Meta)

A Coexistência conecta o número que já roda no WhatsApp Business do celular à Cloud API sem desligar o app. O Prospecter não faz o onboarding (Embedded Signup exige ser Tech Provider): ele recebe o número já conectado, pelo seu app na Meta ou por um BSP que entregue acesso à Graph API.

1. No `.env`: `META_APP_SECRET`, `META_VERIFY_TOKEN` e `PUBLIC_URL` com HTTPS público; recrie o app (`docker compose up -d app`).
2. No App Dashboard → WhatsApp → Configuration: URL `PUBLIC_URL/webhook/meta`, o mesmo verify token e os campos `messages`, `smb_message_echoes`, `history`, `smb_app_state_sync`, `account_update`, `phone_number_quality_update` e `message_template_status_update`.
3. Painel → Números → **+ Número Coex**: Phone number ID, WABA ID e um token de usuário do sistema. O app confere `is_on_biz_app`, inscreve o app na WABA (`subscribed_apps`) e cadastra o número.
4. **Nas primeiras 24h após o onboarding**: "Sincronizar contatos" e "Importar histórico". O histórico só pode ser pedido uma vez; se ele foi recusado no celular, chega o erro 2593109.
5. Crie a campanha com o canal "Cloud API (Coex)", escolha um template aprovado e defina o valor de cada variável (`{{1}}` → `{{primeiro_nome}}`).

Como funciona:

- Envio: `POST /{phone_number_id}/messages` com o template. Não existe a consulta "tem WhatsApp?": o número sem WhatsApp volta como 131026 e vira "Sem WhatsApp". O telefone alternativo do contato não é tentado.
- Webhooks: são gravados em `cloud_events` e respondidos na hora; um processador em segundo plano aplica cada um, com dedupe pelo wamid.
- Espelho: tudo vai para `wa_messages` com `origin`: `api` (campanha), `app` (eco do que você mandou pelo celular), `history` (importação) ou `contact` (resposta ao vivo). Respostas do contato contam como resposta e descadastro, igual ao QR Code. Ecos do celular não contam.
- Proteções automáticas:
  - `PARTNER_REMOVED` (número desconectado pelo celular) tira o número dos disparos.
  - Qualidade `FLAGGED`/`DOWNGRADE` desliga o número até você religar.
  - Template `PAUSED`/`DISABLED` ou erro 132xxx pausa a campanha.
  - O erro 131049 (teto de marketing por pessoa) não é retentado.
  - Erros de token, pagamento ou conta param o número sem gastar tentativas.
- Custo: cada template de marketing entregue é cobrado pela Meta. O "Envio de teste" de uma campanha Coex também é cobrado.

Para desconectar, use o celular: WhatsApp Business → Configurações → Conta → Business Platform → Desconectar. Excluir o número no painel só o tira do Prospecter.

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
- no número Coex (o seu número principal), a qualidade vale para o número e o limite (tier) para o portfolio inteiro: use-o com quem já tem relação com você e deixe a lista fria para um número separado
