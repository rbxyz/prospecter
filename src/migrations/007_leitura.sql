-- Camada de leitura das conversas para outros sistemas (WatchTower, BI, MCP do Neon...).
-- Quem lê usa o role prospecter_leitura (scripts/create-reader.ts), que só enxerga o schema "leitura":
-- as views rodam com as permissões do dono, então as tabelas de public (e o access_token) ficam fora do alcance.
-- instances.display_phone passa a guardar também o número das instâncias da Evolution (vem do ownerJid).
CREATE SCHEMA IF NOT EXISTS leitura;

-- Números de WhatsApp do Prospecter.
CREATE VIEW leitura.numeros AS
SELECT
  i.name          AS instancia,
  i.provider      AS canal,            -- evolution (QR Code) | cloud (Coex)
  i.display_phone AS numero,           -- só dígitos, com DDI
  i.verified_name AS nome_verificado,
  i.enabled       AS ativo,
  i.cloud_status  AS status_cloud,
  i.quality_rating AS qualidade,
  i.created_at    AS criado_em
FROM public.instances i;

-- Cada mensagem do espelho, nos dois sentidos, com o número vinculado e o contato do Prospecter. Sem grupos.
CREATE VIEW leitura.mensagens AS
SELECT
  m.instance                         AS instancia,
  i.display_phone                    AS numero_vinculado,
  coalesce(i.provider, 'evolution')  AS canal,
  coalesce(m.phone_key, m.jid)       AS conversa,          -- chave da conversa dentro do número
  m.phone                            AS telefone_contato,
  m.contact_id,
  c.name                             AS contato,
  c.vars->>'empresa'                 AS empresa,
  c.wt_prospect_id,
  CASE WHEN m.from_me THEN 'enviada' ELSE 'recebida' END AS direcao,
  m.origin                           AS origem,            -- api | app | history | contact (nulo na Evolution)
  m.type                             AS tipo,
  m.text                             AS texto,
  m.push_name                        AS nome_whatsapp,
  m.sent_at                          AS enviada_em,
  m.wa_id                            AS id_whatsapp
FROM public.wa_messages m
LEFT JOIN public.instances i ON i.name = m.instance
LEFT JOIN public.contacts c ON c.id = m.contact_id
WHERE m.jid NOT LIKE '%@g.us';

-- Uma linha por conversa: número vinculado + contato.
CREATE VIEW leitura.conversas AS
SELECT
  instancia,
  numero_vinculado,
  canal,
  conversa,
  max(telefone_contato)                                   AS telefone_contato,
  max(contact_id)                                         AS contact_id,
  max(contato)                                            AS contato,
  max(empresa)                                            AS empresa,
  (array_agg(wt_prospect_id) FILTER (WHERE wt_prospect_id IS NOT NULL))[1] AS wt_prospect_id,
  (array_agg(nome_whatsapp ORDER BY enviada_em DESC NULLS LAST) FILTER (WHERE nome_whatsapp IS NOT NULL))[1] AS nome_whatsapp,
  count(*) FILTER (WHERE direcao = 'enviada')::int        AS enviadas,
  count(*) FILTER (WHERE direcao = 'enviada' AND origem = 'app')::int AS enviadas_pelo_celular,
  count(*) FILTER (WHERE direcao = 'recebida')::int       AS recebidas,
  min(enviada_em)                                         AS primeira_mensagem_em,
  max(enviada_em)                                         AS ultima_mensagem_em,
  (array_agg(texto ORDER BY enviada_em DESC NULLS LAST) FILTER (WHERE texto IS NOT NULL))[1] AS ultimo_texto,
  (array_agg(direcao ORDER BY enviada_em DESC NULLS LAST))[1] AS ultima_direcao
FROM leitura.mensagens
GROUP BY instancia, numero_vinculado, canal, conversa;
