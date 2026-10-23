// Exportação das conversas espelhadas (wa_messages) agrupadas por cliente. Puro: sem banco nem env.

/** Uma mensagem de wa_messages com o número vinculado e o contato do Prospecter. */
export interface ExportRow {
  wa_id: string;
  instance: string;
  instance_phone: string | null;
  jid: string;
  phone: string | null;
  phone_key: string | null;
  from_me: boolean;
  type: string | null;
  text: string | null;
  push_name: string | null;
  sent_at: Date | string | null;
  origin: string | null;
  contact_id: number | string | null;
  contact_name: string | null;
  contact_vars: Record<string, unknown> | null;
  wt_prospect_id: string | null;
}

export interface ExportMessage {
  enviada_em: string | null;
  direcao: 'enviada' | 'recebida';
  instancia: string;
  numero_vinculado: string | null;
  telefone: string | null;
  tipo: string | null;
  texto: string | null;
  origem: string | null;
  nome_whatsapp: string | null;
  id_whatsapp: string;
}

export interface ExportClient {
  contact_id: number | null;
  nome: string | null;
  empresa: string | null;
  wt_prospect_id: string | null;
  nome_whatsapp: string | null;
  dados: Record<string, unknown> | null;
  telefones: string[];
  instancias: string[];
  enviadas: number;
  recebidas: number;
  primeira_mensagem_em: string | null;
  ultima_mensagem_em: string | null;
  mensagens: ExportMessage[];
}

/** Mesma chave de conversa do painel: phone_key, ou "instância:jid" quando o número é desconhecido. */
export function conversationKey(row: Pick<ExportRow, 'phone_key' | 'instance' | 'jid'>): string {
  return row.phone_key ?? `${row.instance}:${row.jid}`;
}

const iso = (v: Date | string | null): string | null => (v == null ? null : new Date(v).toISOString());

/**
 * Agrupa as mensagens por cliente: pelo contato do Prospecter quando há vínculo (junta os vários
 * números do mesmo contato), senão pela conversa. Mensagens em ordem cronológica; clientes da
 * conversa mais recente para a mais antiga.
 */
export function groupByClient(rows: ExportRow[]): ExportClient[] {
  const clients = new Map<string, ExportClient>();
  for (const row of rows) {
    const id = row.contact_id == null ? null : Number(row.contact_id);
    const key = id != null ? `contato:${id}` : conversationKey(row);
    let client = clients.get(key);
    if (!client) {
      const vars = row.contact_vars && Object.keys(row.contact_vars).length ? row.contact_vars : null;
      client = {
        contact_id: id,
        nome: row.contact_name || null,
        empresa: typeof vars?.empresa === 'string' && vars.empresa ? vars.empresa : null,
        wt_prospect_id: row.wt_prospect_id,
        nome_whatsapp: null,
        dados: vars,
        telefones: [],
        instancias: [],
        enviadas: 0,
        recebidas: 0,
        primeira_mensagem_em: null,
        ultima_mensagem_em: null,
        mensagens: [],
      };
      clients.set(key, client);
    }
    const sentAt = iso(row.sent_at);
    if (row.phone && !client.telefones.includes(row.phone)) client.telefones.push(row.phone);
    if (!client.instancias.includes(row.instance)) client.instancias.push(row.instance);
    if (row.from_me) client.enviadas++;
    else {
      client.recebidas++;
      // Em mensagens enviadas o pushName é o nosso; vale o último nome que o cliente usou.
      if (row.push_name) client.nome_whatsapp = row.push_name;
    }
    if (sentAt) {
      if (!client.primeira_mensagem_em || sentAt < client.primeira_mensagem_em) client.primeira_mensagem_em = sentAt;
      if (!client.ultima_mensagem_em || sentAt > client.ultima_mensagem_em) client.ultima_mensagem_em = sentAt;
    }
    client.mensagens.push({
      enviada_em: sentAt,
      direcao: row.from_me ? 'enviada' : 'recebida',
      instancia: row.instance,
      numero_vinculado: row.instance_phone,
      telefone: row.phone,
      tipo: row.type,
      texto: row.text,
      origem: row.origin,
      nome_whatsapp: row.from_me ? null : row.push_name,
      id_whatsapp: row.wa_id,
    });
  }
  const list = [...clients.values()];
  for (const c of list) c.mensagens.sort((a, b) => (a.enviada_em ?? '').localeCompare(b.enviada_em ?? ''));
  return list.sort((a, b) => (b.ultima_mensagem_em ?? '').localeCompare(a.ultima_mensagem_em ?? ''));
}
