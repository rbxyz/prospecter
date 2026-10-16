-- Números de WhatsApp (instâncias da Evolution API) usados para prospectar.
CREATE TABLE instances (
  name         text PRIMARY KEY,
  daily_limit  integer NOT NULL DEFAULT 40,
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contacts (
  id            bigserial PRIMARY KEY,
  phone         text NOT NULL,                  -- só dígitos, com DDI (ex.: 5511999998888)
  phone_key     text NOT NULL UNIQUE,           -- chave de deduplicação (ignora o 9º dígito no Brasil)
  name          text NOT NULL DEFAULT '',
  vars          jsonb NOT NULL DEFAULT '{}',    -- colunas extras do CSV, usadas no template
  opted_out_at  timestamptz,
  last_reply_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaigns (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL,
  template      text NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'paused', 'done')),
  instances     text[] NOT NULL DEFAULT '{}',   -- vazio = todos os números habilitados
  delay_min_s   integer NOT NULL DEFAULT 60,
  delay_max_s   integer NOT NULL DEFAULT 180,
  window_start  text NOT NULL DEFAULT '09:00',
  window_end    text NOT NULL DEFAULT '18:00',
  weekdays      integer[] NOT NULL DEFAULT '{1,2,3,4,5}',  -- 0 = domingo
  skip_replied  boolean NOT NULL DEFAULT true,   -- não envia para quem já respondeu antes
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id            bigserial PRIMARY KEY,
  campaign_id   bigint NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  contact_id    bigint NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'invalid', 'skipped')),
  instance      text,
  text          text,
  wa_message_id text,
  error         text,
  attempts      integer NOT NULL DEFAULT 0,
  sent_at       timestamptz,
  replied_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, contact_id)
);
CREATE INDEX messages_queue_idx ON messages (campaign_id, status, id);
CREATE INDEX messages_instance_sent_idx ON messages (instance, sent_at);

-- Respostas recebidas pelo webhook.
CREATE TABLE inbound (
  id           bigserial PRIMARY KEY,
  instance     text NOT NULL,
  contact_id   bigint REFERENCES contacts (id) ON DELETE SET NULL,
  phone        text NOT NULL,
  push_name    text,
  text         text,
  opt_out      boolean NOT NULL DEFAULT false,
  received_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inbound_received_idx ON inbound (received_at DESC);
