-- Cópia local do que está nas instâncias do WhatsApp (contatos e conversas guardados pela Evolution),
-- para concentrar no banco do Prospecter tudo o que foi falado com cada empresa, inclusive o que
-- foi enviado/recebido direto pelo celular, fora das campanhas.

-- Um contato da instância. O mesmo número pode aparecer duas vezes (JID @s.whatsapp.net e @lid);
-- phone traz o número real quando conhecido, e contact_id liga ao contato do Prospecter.
CREATE TABLE wa_contacts (
  instance         text NOT NULL,
  jid              text NOT NULL,
  phone            text,
  phone_key        text,
  push_name        text,
  profile_pic_url  text,
  is_group         boolean NOT NULL DEFAULT false,
  contact_id       bigint REFERENCES contacts (id) ON DELETE SET NULL,
  last_message_at  timestamptz,
  synced_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance, jid)
);
CREATE INDEX wa_contacts_phone_key_idx ON wa_contacts (phone_key);
CREATE INDEX wa_contacts_contact_idx ON wa_contacts (contact_id);

-- Cada mensagem da instância, nos dois sentidos (from_me = enviada por nós).
CREATE TABLE wa_messages (
  instance    text NOT NULL,
  wa_id       text NOT NULL,              -- key.id da mensagem no WhatsApp
  jid         text NOT NULL,              -- conversa (remoteJid)
  phone       text,
  phone_key   text,
  from_me     boolean NOT NULL,
  type        text,                       -- conversation, audioMessage, imageMessage...
  text        text,
  push_name   text,                       -- nome do remetente quando a mensagem é recebida
  sent_at     timestamptz,
  contact_id  bigint REFERENCES contacts (id) ON DELETE SET NULL,
  synced_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance, wa_id)
);
CREATE INDEX wa_messages_contact_idx ON wa_messages (contact_id, sent_at);
CREATE INDEX wa_messages_phone_key_idx ON wa_messages (phone_key, sent_at);
CREATE INDEX wa_messages_jid_idx ON wa_messages (instance, jid, sent_at);
