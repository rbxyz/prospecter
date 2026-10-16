import { parseContactsInput } from './csv.ts';
import { sql } from './db.ts';
import { parsePhoneList, phoneKey } from './phone.ts';

export interface ImportResult {
  received: number;
  queued: number;
  alreadyInCampaign: number;
  duplicatesInFile: number;
  invalid: string[];
}

/** Um contato a importar, venha de CSV ou do WatchTower. */
export interface ContactInput {
  /** Um ou mais telefones no formato que vier ("(51) 3714-1234 / (51) 99999-8888"). */
  phonesRaw: string;
  name: string;
  vars: Record<string, string>;
  wtProspectId?: string;
}

export function importCsvToCampaign(campaignId: number, input: string): Promise<ImportResult> {
  return importContactsToCampaign(
    campaignId,
    parseContactsInput(input).map((c) => ({ phonesRaw: c.phoneRaw, name: c.name, vars: c.vars })),
  );
}

export async function importContactsToCampaign(campaignId: number, inputs: ContactInput[]): Promise<ImportResult> {
  const result: ImportResult = { received: inputs.length, queued: 0, alreadyInCampaign: 0, duplicatesInFile: 0, invalid: [] };

  const byKey = new Map<string, Record<string, unknown>>();
  for (const c of inputs) {
    const [phone, ...alt] = parsePhoneList(c.phonesRaw);
    if (!phone) {
      result.invalid.push(c.phonesRaw?.trim() || `(vazio${c.name ? `: ${c.name}` : ''})`);
      continue;
    }
    const key = phoneKey(phone);
    if (byKey.has(key)) {
      result.duplicatesInFile++;
      continue;
    }
    byKey.set(key, {
      phone,
      phone_key: key,
      phone_keys: [phone, ...alt].map(phoneKey),
      alt_phones: alt,
      name: c.name,
      vars: c.vars,
      wt_prospect_id: c.wtProspectId ?? null,
    });
  }

  const rows = [...byKey.values()];
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    await sql.begin(async (tx) => {
      const contacts = await tx<{ id: number }[]>`
        INSERT INTO contacts (phone, phone_key, phone_keys, alt_phones, name, vars, wt_prospect_id)
        SELECT phone, phone_key, phone_keys, alt_phones, name, vars, wt_prospect_id
        FROM jsonb_to_recordset(${tx.json(chunk as never)}) AS t(
          phone text, phone_key text, phone_keys text[], alt_phones text[], name text, vars jsonb, wt_prospect_id uuid
        )
        ON CONFLICT (phone_key) DO UPDATE SET
          phone = excluded.phone,
          alt_phones = excluded.alt_phones,
          phone_keys = excluded.phone_keys,
          name = coalesce(nullif(excluded.name, ''), contacts.name),
          vars = contacts.vars || excluded.vars,
          wt_prospect_id = coalesce(excluded.wt_prospect_id, contacts.wt_prospect_id)
        RETURNING id`;
      const inserted = await tx`
        INSERT INTO messages (campaign_id, contact_id)
        SELECT ${campaignId}, unnest(${tx.array(contacts.map((c) => c.id))}::bigint[])
        ON CONFLICT (campaign_id, contact_id) DO NOTHING`;
      result.queued += inserted.count;
      result.alreadyInCampaign += contacts.length - inserted.count;
    });
  }

  // Quem já se descadastrou entra na campanha como "skipped", para ficar visível no relatório.
  await sql`
    UPDATE messages m SET status = 'skipped', error = 'contato pediu para sair'
    FROM contacts c
    WHERE m.contact_id = c.id AND m.campaign_id = ${campaignId}
      AND m.status = 'pending' AND c.opted_out_at IS NOT NULL`;

  return result;
}
