-- Prospectos do WatchTower costumam ter mais de um telefone ("(51) 3714-1234 / (51) 99999-8888").
-- phone continua sendo o principal (e phone_key a chave de deduplicação); os demais ficam em alt_phones
-- e todas as chaves em phone_keys, para casar respostas vindas de qualquer um deles.
ALTER TABLE contacts ADD COLUMN alt_phones text[] NOT NULL DEFAULT '{}';
ALTER TABLE contacts ADD COLUMN phone_keys text[] NOT NULL DEFAULT '{}';
ALTER TABLE contacts ADD COLUMN wt_prospect_id uuid;
UPDATE contacts SET phone_keys = ARRAY[phone_key];
CREATE INDEX contacts_phone_keys_idx ON contacts USING gin (phone_keys);
CREATE INDEX contacts_wt_prospect_idx ON contacts (wt_prospect_id);

-- Número que de fato recebeu a mensagem (o principal ou um alternativo com WhatsApp).
ALTER TABLE messages ADD COLUMN to_phone text;

-- Configurações e credenciais OAuth da integração.
CREATE TABLE kv (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Escritas pendentes no WatchTower (anotações e mudanças de etapa), processadas em segundo plano
-- para que uma falha na integração nunca trave o disparo.
CREATE TABLE watchtower_outbox (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('note', 'move')),
  prospect_id  uuid NOT NULL,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'skipped', 'failed')),
  attempts     integer NOT NULL DEFAULT 0,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  done_at      timestamptz
);
CREATE INDEX watchtower_outbox_pending_idx ON watchtower_outbox (status, id);
