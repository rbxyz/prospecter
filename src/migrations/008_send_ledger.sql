-- Registro permanente de quem já recebeu mensagem, em qualquer campanha (ou fora do Prospecter).
-- O disparador nunca envia para um contato cujo telefone ou prospecto do WatchTower esteja aqui,
-- mesmo que ele seja importado de novo com outro telefone principal ou em outra campanha.
-- Cada linha tem phone_key, wt_prospect_id ou os dois.
CREATE TABLE send_ledger (
  id              bigserial PRIMARY KEY,
  phone_key       text,
  wt_prospect_id  uuid,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  source          text NOT NULL,   -- ex.: 'campanha 3' ou 'histórico: Contabil SCS 16/10/2026'
  CHECK (phone_key IS NOT NULL OR wt_prospect_id IS NOT NULL)
);
CREATE INDEX send_ledger_phone_key_idx ON send_ledger (phone_key);
CREATE INDEX send_ledger_wt_prospect_idx ON send_ledger (wt_prospect_id);

-- Envios já feitos por este banco entram no registro.
INSERT INTO send_ledger (phone_key, wt_prospect_id, sent_at, source)
SELECT k, c.wt_prospect_id, m.sent_at, 'campanha ' || m.campaign_id
FROM messages m
JOIN contacts c ON c.id = m.contact_id
CROSS JOIN LATERAL unnest(c.phone_keys) AS k
WHERE m.status = 'sent';
