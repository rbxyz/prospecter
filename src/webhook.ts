import { config } from './config.ts';
import { sql } from './db.ts';
import { evolution, type ConnectionState } from './evolution.ts';
import { setCachedState } from './instances.ts';
import { isOptOut } from './optout.ts';
import { jidToPhone, phoneKey } from './phone.ts';
import { enqueueMove, getSettings } from './watchtower.ts';

interface MessageKey {
  remoteJid?: string;
  remoteJidAlt?: string;
  senderPn?: string;
  fromMe?: boolean;
}

interface UpsertData {
  key?: MessageKey;
  pushName?: string;
  message?: Record<string, any>;
}

export interface WebhookPayload {
  event?: string;
  instance?: string;
  data?: any;
}

/** Texto de uma mensagem recebida (texto puro, texto estendido ou legenda de mídia). */
export function extractText(message: Record<string, any> | undefined): string {
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

/** Telefone do remetente. Em contas com LID, o número real vem em remoteJidAlt/senderPn. */
export function senderPhone(key: MessageKey): string | null {
  return jidToPhone(key.remoteJid) ?? jidToPhone(key.remoteJidAlt) ?? jidToPhone(key.senderPn);
}

export async function handleWebhook(payload: WebhookPayload): Promise<void> {
  const event = (payload.event ?? '').toLowerCase().replace(/_/g, '.');
  const instance = payload.instance ?? '';

  if (event === 'connection.update') {
    const state = payload.data?.state as ConnectionState | undefined;
    if (instance && state) setCachedState(instance, state);
    return;
  }

  if (event !== 'messages.upsert') return;
  const items: UpsertData[] = Array.isArray(payload.data) ? payload.data : [payload.data];
  for (const item of items) {
    if (item?.key) await handleIncoming(instance, item);
  }
}

async function handleIncoming(instance: string, item: UpsertData): Promise<void> {
  const key = item.key!;
  if (key.fromMe) return;
  if (key.remoteJid?.endsWith('@g.us') || key.remoteJid === 'status@broadcast') return;

  const phone = senderPhone(key);
  if (!phone) return;
  const text = extractText(item.message);
  const optOut = isOptOut(text, config.optOut.keywords);

  const [contact] = await sql<
    { id: number; opted_out_at: Date | null; last_reply_at: Date | null; wt_prospect_id: string | null }[]
  >`
    SELECT id, opted_out_at, last_reply_at, wt_prospect_id FROM contacts
    WHERE ${phoneKey(phone)} = ANY (phone_keys)
    ORDER BY (phone_key = ${phoneKey(phone)}) DESC
    LIMIT 1`;

  await sql`
    INSERT INTO inbound (instance, contact_id, phone, push_name, text, opt_out)
    VALUES (${instance}, ${contact?.id ?? null}, ${phone}, ${item.pushName ?? null}, ${text}, ${optOut})`;

  if (!contact) return;

  await sql`UPDATE contacts SET last_reply_at = now() WHERE id = ${contact.id}`;
  await sql`
    UPDATE messages SET replied_at = now()
    WHERE id = (
      SELECT id FROM messages
      WHERE contact_id = ${contact.id} AND status = 'sent' AND replied_at IS NULL
      ORDER BY sent_at DESC LIMIT 1
    )`;

  // Primeira resposta de um prospecto do WatchTower: avança no funil (ex.: Novo → Iniciado atendimento).
  if (!optOut && !contact.last_reply_at && contact.wt_prospect_id) {
    const wt = await getSettings();
    if (wt.moveOnReply && wt.moveFromStageId && wt.moveToStageId) {
      await enqueueMove(contact.wt_prospect_id, wt.moveFromStageId, wt.moveToStageId);
    }
  }

  if (optOut && !contact.opted_out_at) {
    await optOutContact(contact.id);
    console.log(`[webhook] ${phone} pediu para sair da lista`);
    if (config.optOut.reply && instance) {
      // Sem await: o webhook precisa responder rápido para a Evolution.
      evolution
        .sendText(instance, phone, config.optOut.reply, 1500)
        .catch((err) => console.warn('[webhook] falha ao responder descadastro:', (err as Error).message));
    }
  }
}

/** Marca o contato como descadastrado e cancela tudo que ainda estava na fila para ele. */
export async function optOutContact(contactId: number): Promise<void> {
  await sql`UPDATE contacts SET opted_out_at = now() WHERE id = ${contactId} AND opted_out_at IS NULL`;
  await sql`
    UPDATE messages SET status = 'skipped', error = 'contato pediu para sair'
    WHERE contact_id = ${contactId} AND status = 'pending'`;
}
