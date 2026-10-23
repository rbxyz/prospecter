-- Números conectados pela Cloud API da Meta em Coexistência (Coex): o mesmo número continua no
-- WhatsApp Business do celular. As campanhas saem por template aprovado; as conversas seguem no app.
ALTER TABLE instances ADD COLUMN provider text NOT NULL DEFAULT 'evolution' CHECK (provider IN ('evolution', 'cloud'));
ALTER TABLE instances ADD COLUMN phone_number_id text UNIQUE;
ALTER TABLE instances ADD COLUMN waba_id text;
ALTER TABLE instances ADD COLUMN access_token text;           -- nunca vai para o painel
ALTER TABLE instances ADD COLUMN display_phone text;          -- só dígitos, com DDI
ALTER TABLE instances ADD COLUMN verified_name text;
ALTER TABLE instances ADD COLUMN quality_rating text;         -- GREEN, YELLOW, RED (ou o último evento de qualidade)
ALTER TABLE instances ADD COLUMN is_on_biz_app boolean;       -- true = número em Coex
-- connected | disconnected (PARTNER_REMOVED) | error (token, pagamento, conta bloqueada...). Nulo nas instâncias da Evolution.
ALTER TABLE instances ADD COLUMN cloud_status text CHECK (cloud_status IN ('connected', 'disconnected', 'error'));
ALTER TABLE instances ADD COLUMN cloud_error text;
ALTER TABLE instances ADD COLUMN contacts_sync_at timestamptz;
ALTER TABLE instances ADD COLUMN history_sync_at timestamptz; -- o histórico só pode ser pedido uma vez
ALTER TABLE instances ADD COLUMN history_progress integer;
ALTER TABLE instances ADD COLUMN history_error text;

-- Campanha da Cloud API: o primeiro contato só pode ser um template aprovado pela Meta.
-- cloud_template = { waba_id, name, language, body, format, params: { "1": "{{primeiro_nome}}", ... } }
-- e campaigns.template guarda o corpo do template (para exibir).
ALTER TABLE campaigns ADD COLUMN provider text NOT NULL DEFAULT 'evolution' CHECK (provider IN ('evolution', 'cloud'));
ALTER TABLE campaigns ADD COLUMN cloud_template jsonb;

-- Status de entrega que a Cloud API devolve pelo webhook (a cobrança é por mensagem entregue).
ALTER TABLE messages ADD COLUMN delivered_at timestamptz;
ALTER TABLE messages ADD COLUMN read_at timestamptz;
CREATE INDEX messages_wa_message_idx ON messages (wa_message_id) WHERE wa_message_id IS NOT NULL;

-- De onde veio a mensagem do espelho: api (enviada pela Cloud API), app (enviada pelo celular,
-- eco smb_message_echoes), history (importada na sincronização) ou contact (recebida ao vivo).
-- Nula nas mensagens da Evolution.
ALTER TABLE wa_messages ADD COLUMN origin text;

-- Webhooks da Meta: gravados assim que chegam (a Meta reenvia o que não recebe 200 rápido)
-- e processados em segundo plano.
CREATE TABLE cloud_events (
  id           bigserial PRIMARY KEY,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts     integer NOT NULL DEFAULT 0,
  error        text,
  received_at  timestamptz NOT NULL DEFAULT now(),
  done_at      timestamptz
);
CREATE INDEX cloud_events_pending_idx ON cloud_events (status, id);
