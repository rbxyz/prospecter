import { jidToPhone, phoneKey } from './phone.ts';

/** Chave da mensagem como vem da Evolution (webhook e /chat/findMessages). */
export interface EvoMessageKey {
  id?: string;
  remoteJid?: string;
  remoteJidAlt?: string;
  senderPn?: string;
  fromMe?: boolean;
}

export interface EvoMessage {
  key?: EvoMessageKey;
  pushName?: string | null;
  messageType?: string;
  message?: Record<string, any> | null;
  messageTimestamp?: number | string | { low: number } | null;
}

/** Contato como vem de /chat/findContacts (só os campos usados). */
export interface EvoContact {
  remoteJid?: string;
  pushName?: string | null;
  profilePicUrl?: string | null;
  isGroup?: boolean;
}

export interface WaMessageRow {
  wa_id: string;
  jid: string;
  phone: string | null;
  phone_key: string | null;
  from_me: boolean;
  type: string | null;
  text: string | null;
  push_name: string | null;
  sent_at: Date | null;
}

export interface WaContactRow {
  jid: string;
  phone: string | null;
  phone_key: string | null;
  push_name: string | null;
  profile_pic_url: string | null;
  is_group: boolean;
  last_message_at: Date | null;
}

/** Texto de uma mensagem (texto puro, texto estendido ou legenda de mídia). */
export function extractText(message: Record<string, any> | null | undefined): string {
  if (!message) return '';
  return (
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption ??
    message.buttonsResponseMessage?.selectedDisplayText ??
    message.listResponseMessage?.title ??
    ''
  );
}

/** Telefone da conversa. Em contas com LID, o número real vem em remoteJidAlt/senderPn. */
export function senderPhone(key: EvoMessageKey): string | null {
  return jidToPhone(key.remoteJid) ?? jidToPhone(key.remoteJidAlt) ?? jidToPhone(key.senderPn);
}

/** Conversas que não interessam: status, canais e broadcast. */
export function isIgnoredJid(jid: string | undefined): boolean {
  return !jid || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast');
}

function timestamp(value: EvoMessage['messageTimestamp']): Date | null {
  const seconds = typeof value === 'object' && value ? value.low : Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
}

/** JID @lid → número real, aprendido das mensagens que trazem os dois. */
export function lidPhoneMap(messages: EvoMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    const jid = m.key?.remoteJid;
    if (!jid?.endsWith('@lid')) continue;
    const phone = jidToPhone(m.key!.remoteJidAlt) ?? jidToPhone(m.key!.senderPn);
    if (phone) map.set(jid, phone);
  }
  return map;
}

/** Converte uma mensagem da Evolution em linha de wa_messages (null quando não serve). */
export function toWaMessage(m: EvoMessage, lidPhones = new Map<string, string>()): WaMessageRow | null {
  const key = m.key;
  const jid = key?.remoteJid;
  if (!key?.id || !jid || isIgnoredJid(jid)) return null;
  const isGroup = jid.endsWith('@g.us');
  const phone = isGroup ? null : (senderPhone(key) ?? lidPhones.get(jid) ?? null);
  const fromMe = Boolean(key.fromMe);
  return {
    wa_id: key.id,
    jid,
    phone,
    phone_key: phone ? phoneKey(phone) : null,
    from_me: fromMe,
    type: m.messageType ?? (m.message ? (Object.keys(m.message).find((k) => k !== 'messageContextInfo') ?? null) : null),
    text: extractText(m.message) || null,
    // Em mensagens enviadas, pushName é o nosso próprio nome.
    push_name: fromMe ? null : (m.pushName ?? null),
    sent_at: timestamp(m.messageTimestamp),
  };
}

/**
 * Junta os contatos da instância com o que se aprende das mensagens: número real dos @lid,
 * nome de quem escreveu (quando o contato não tem) e a data da última mensagem.
 * Conversas que só existem nas mensagens também viram contato.
 */
export function toWaContacts(contacts: EvoContact[], messages: WaMessageRow[], lidPhones = new Map<string, string>()): WaContactRow[] {
  const byJid = new Map<string, WaContactRow>();
  for (const c of contacts) {
    const jid = c.remoteJid;
    if (!jid || isIgnoredJid(jid)) continue;
    const isGroup = Boolean(c.isGroup) || jid.endsWith('@g.us');
    const phone = isGroup ? null : (jidToPhone(jid) ?? lidPhones.get(jid) ?? null);
    byJid.set(jid, {
      jid,
      phone,
      phone_key: phone ? phoneKey(phone) : null,
      push_name: c.pushName || null,
      profile_pic_url: c.profilePicUrl || null,
      is_group: isGroup,
      last_message_at: null,
    });
  }
  for (const m of messages) {
    let row = byJid.get(m.jid);
    if (!row) {
      row = {
        jid: m.jid,
        phone: m.phone,
        phone_key: m.phone_key,
        push_name: null,
        profile_pic_url: null,
        is_group: m.jid.endsWith('@g.us'),
        last_message_at: null,
      };
      byJid.set(m.jid, row);
    }
    if (!row.phone && m.phone) {
      row.phone = m.phone;
      row.phone_key = m.phone_key;
    }
    if (!row.push_name && m.push_name && !row.is_group) row.push_name = m.push_name;
    if (m.sent_at && (!row.last_message_at || m.sent_at > row.last_message_at)) row.last_message_at = m.sent_at;
  }
  return [...byJid.values()];
}
