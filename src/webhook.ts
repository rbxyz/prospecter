import { config } from './config.ts';
import { sql } from './db.ts';
import { evolution, type ConnectionState } from './evolution.ts';
import { setCachedState } from './instances.ts';
import { isOptOut } from './optout.ts';
import { phoneKey } from './phone.ts';
import { extractText, senderPhone, type EvoMessage } from './wa-map.ts';
import { recordWebhookMessages } from './wa-sync.ts';
import { enqueueMove, getSettings } from './watchtower.ts';

export interface WebhookPayload {
  event?: string;
  instance?: string;
  data?: any;
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
  const items: EvoMessage[] = (Array.isArray(payload.data) ? payload.data : [payload.data]).filter((i) => i?.key);
  // Guarda a conversa (nos dois sentidos); uma falha aqui não pode impedir o registro da resposta.
  await recordWebhookMessages(instance, items).catch((err) =>
    console.warn('[webhook] falha ao gravar mensagem do WhatsApp:', (err as Error).message),
  );
  for (const item of items) await handleIncoming(instance, item);
}

async function handleIncoming(instance: string, item: EvoMessage): Promise<void> {
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

  // Com "mover ao responder": a primeira resposta avança o prospecto no funil.
  if (!optOut && !contact.last_reply_at && contact.wt_prospect_id) {
    const wt = await getSettings();
    if (wt.moveEnabled && wt.moveTrigger === 'reply' && wt.moveFromStageId && wt.moveToStageId) {
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
