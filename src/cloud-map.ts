import { phoneKey } from './phone.ts';
import { renderChecked, templateVars, validateTemplate, type TemplateVars } from './template.ts';
import type { WaContactRow, WaMessageRow } from './wa-map.ts';

// ---------- Templates ----------

/** Template como vem de GET /{waba_id}/message_templates (só os campos usados). */
export interface MetaTemplate {
  name: string;
  language: string;
  status: string;
  category?: string;
  parameter_format?: 'POSITIONAL' | 'NAMED';
  components?: {
    type: string;
    format?: string;
    text?: string;
    buttons?: { type: string; text?: string; url?: string }[];
  }[];
}

/** Template escolhido numa campanha, com o valor de cada variável do corpo. */
export interface CloudTemplate {
  waba_id: string;
  name: string;
  language: string;
  body: string;
  format: 'POSITIONAL' | 'NAMED';
  /** Variável do template ("1", "2" ou "nome") → texto com a marcação do Prospecter ({{empresa}}, {a|b}). */
  params: Record<string, string>;
}

const PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

/** Variáveis do corpo do template, na ordem em que a Meta espera os parâmetros. */
export function bodyPlaceholders(body: string, format: CloudTemplate['format'] = 'POSITIONAL'): string[] {
  const keys = [...new Set([...body.matchAll(PLACEHOLDER)].map((m) => m[1]))];
  return format === 'POSITIONAL' ? keys.sort((a, b) => Number(a) - Number(b)) : keys;
}

const component = (t: MetaTemplate, type: string) => t.components?.find((c) => c.type.toUpperCase() === type);

/** O que impede usar o template numa campanha (o Prospecter só preenche variáveis do corpo). */
export function metaTemplateProblems(t: MetaTemplate): string[] {
  const problems: string[] = [];
  if (t.status !== 'APPROVED') problems.push(`template não aprovado (${t.status})`);
  const header = component(t, 'HEADER');
  if (header && header.format && header.format !== 'TEXT') problems.push(`cabeçalho com mídia (${header.format}) não é suportado`);
  if (header?.text && /\{\{/.test(header.text)) problems.push('cabeçalho com variável não é suportado');
  for (const b of component(t, 'BUTTONS')?.buttons ?? []) {
    if (b.url && /\{\{/.test(b.url)) problems.push(`botão "${b.text ?? b.type}" com URL variável não é suportado`);
  }
  if (!component(t, 'BODY')?.text) problems.push('template sem corpo de texto');
  return problems;
}

/** Corpo e formato do template, para guardar na campanha (os params vêm do painel). */
export function describeTemplate(t: MetaTemplate): { body: string; format: CloudTemplate['format']; placeholders: string[] } {
  const body = component(t, 'BODY')?.text ?? '';
  const format = t.parameter_format === 'NAMED' ? 'NAMED' : 'POSITIONAL';
  return { body, format, placeholders: bodyPlaceholders(body, format) };
}

/** Erros que impedem salvar a campanha com este template. */
export function validateCloudTemplate(t: Partial<CloudTemplate> | null | undefined): string[] {
  if (!t?.name || !t.language || !t.waba_id || !t.body) return ['Escolha um template aprovado'];
  const errors: string[] = [];
  for (const key of bodyPlaceholders(t.body, t.format)) {
    const expr = t.params?.[key] ?? '';
    if (!expr.trim()) {
      errors.push(`Defina o valor de {{${key}}}`);
      continue;
    }
    errors.push(...validateTemplate(expr).map((e) => `{{${key}}}: ${e}`));
  }
  return errors;
}

/** Variáveis do contato usadas nos valores do template. */
export function cloudTemplateVars(t: CloudTemplate): string[] {
  return [...new Set(Object.values(t.params ?? {}).flatMap((expr) => templateVars(expr)))];
}

export interface CloudParameter {
  type: 'text';
  text: string;
  parameter_name?: string;
}

export interface CheckedCloudMessage {
  /** Texto final como o contato vai ler (para o histórico, a prévia e o WatchTower). */
  text: string;
  /** Parâmetros do componente "body" no envio. */
  parameters: CloudParameter[];
  problems: string[];
}

/**
 * Monta os parâmetros do template para um contato com as mesmas regras do texto livre
 * (`renderChecked`): variável vazia ou marcação sobrando bloqueiam o envio.
 */
export function renderCloud(t: CloudTemplate, vars: TemplateVars, random: () => number = Math.random): CheckedCloudMessage {
  const problems: string[] = [];
  const values = new Map<string, string>();
  for (const key of bodyPlaceholders(t.body, t.format)) {
    const expr = t.params?.[key] ?? '';
    if (!expr.trim()) {
      problems.push(`{{${key}}} do template sem valor definido`);
      values.set(key, '');
      continue;
    }
    const r = renderChecked(expr, vars, random);
    problems.push(...r.problems.map((p) => `{{${key}}}: ${p}`));
    // A Meta recusa parâmetro com quebra de linha, tabulação ou mais de 4 espaços seguidos.
    if (/[\n\t]| {5,}/.test(r.text)) problems.push(`{{${key}}}: o valor não pode ter quebra de linha nem tabulação`);
    values.set(key, r.text);
  }
  const text = t.body.replace(PLACEHOLDER, (_, key: string) => values.get(key) ?? '');
  const parameters = [...values].map(([key, value]): CloudParameter =>
    t.format === 'NAMED' ? { type: 'text', parameter_name: key, text: value } : { type: 'text', text: value },
  );
  return { text, parameters, problems };
}

// ---------- Erros da Graph API ----------

export type CloudErrorKind = 'invalid' | 'user-limit' | 'retry' | 'template' | 'account' | 'other';

/**
 * O que fazer com um erro de envio, pelo código da Meta:
 *  - invalid: número sem WhatsApp → mensagem "invalid"
 *  - user-limit: teto de marketing por pessoa (131049) → não retentar no mesmo dia
 *  - retry: limite de taxa/instabilidade → volta para a fila
 *  - template: template inexistente, pausado ou com parâmetros errados → para a campanha
 *  - account: token, pagamento ou conta bloqueada → para o número sem gastar tentativas
 */
export function classifyCloudError(code: number | null | undefined): CloudErrorKind {
  if (code == null) return 'other';
  if (code === 131026) return 'invalid';
  if (code === 131049) return 'user-limit';
  if ([1, 2, 4, 80007, 130429, 131000, 131016, 131056, 133004].includes(code)) return 'retry';
  if (code >= 132000 && code < 133000) return 'template';
  if ([10, 190, 200, 368, 131031, 131042, 131045, 133010].includes(code)) return 'account';
  return 'other';
}

// ---------- Webhooks ----------

export interface CloudWaRow extends WaMessageRow {
  origin: 'api' | 'app' | 'history' | 'contact';
}

export type CloudEvent =
  | { kind: 'message'; phoneNumberId: string; row: CloudWaRow; pushName: string | null }
  | { kind: 'echo'; phoneNumberId: string; row: CloudWaRow }
  | { kind: 'history'; phoneNumberId: string; rows: CloudWaRow[]; progress: number | null; error: string | null }
  | { kind: 'status'; phoneNumberId: string; waId: string; status: string; at: Date | null; error: { code: number | null; message: string } | null }
  | { kind: 'contact'; phoneNumberId: string; contact: WaContactRow }
  | { kind: 'account'; wabaId: string; event: string; phone: string | null }
  | { kind: 'quality'; wabaId: string; phone: string | null; event: string; limit: string | null }
  | { kind: 'template'; wabaId: string; name: string; language: string | null; event: string; reason: string | null };

/** Mensagem como vem nos campos messages, message_echoes e history da Cloud API. */
export interface CloudMessage {
  id?: string;
  from?: string;
  to?: string;
  timestamp?: string | number;
  type?: string;
  [type: string]: any;
}

const digits = (v: unknown): string | null => {
  const d = String(v ?? '').replace(/\D/g, '');
  return d || null;
};

const seconds = (v: unknown): Date | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
};

/** Texto de uma mensagem da Cloud API (texto, legenda de mídia, botão ou resposta de lista). */
export function cloudMessageText(m: CloudMessage): string {
  return (
    m.text?.body ??
    m.image?.caption ??
    m.video?.caption ??
    m.document?.caption ??
    m.button?.text ??
    m.interactive?.button_reply?.title ??
    m.interactive?.list_reply?.title ??
    m.reaction?.emoji ??
    ''
  );
}

/** Linha de wa_messages para uma mensagem da Cloud API trocada com `contact` (número do cliente). */
export function toCloudWaMessage(m: CloudMessage, contact: string, fromMe: boolean, origin: CloudWaRow['origin']): CloudWaRow | null {
  const phone = digits(contact);
  if (!m.id || !phone) return null;
  return {
    wa_id: m.id,
    jid: `${phone}@s.whatsapp.net`,
    phone,
    phone_key: phoneKey(phone),
    from_me: fromMe,
    type: m.type ?? null,
    text: cloudMessageText(m) || null,
    push_name: null,
    sent_at: seconds(m.timestamp),
    origin,
  };
}

/** Transforma o corpo de um webhook da Meta (object whatsapp_business_account) em eventos. */
export function parseCloudWebhook(payload: any): CloudEvent[] {
  const events: CloudEvent[] = [];
  for (const entry of payload?.entry ?? []) {
    const wabaId = String(entry?.id ?? '');
    for (const change of entry?.changes ?? []) {
      const field = change?.field;
      const value = change?.value ?? {};
      const phoneNumberId = String(value.metadata?.phone_number_id ?? '');

      if (field === 'messages') {
        const names = new Map<string, string>();
        for (const c of value.contacts ?? []) if (c?.wa_id && c.profile?.name) names.set(String(c.wa_id), c.profile.name);
        for (const m of value.messages ?? []) {
          const row = toCloudWaMessage(m, m.from, false, 'contact');
          if (row) events.push({ kind: 'message', phoneNumberId, row: { ...row, push_name: names.get(m.from) ?? null }, pushName: names.get(m.from) ?? null });
        }
        for (const s of value.statuses ?? []) {
          if (!s?.id) continue;
          const err = s.errors?.[0];
          events.push({
            kind: 'status',
            phoneNumberId,
            waId: s.id,
            status: String(s.status ?? ''),
            at: seconds(s.timestamp),
            error: err
              ? { code: Number.isFinite(Number(err.code)) ? Number(err.code) : null, message: err.error_data?.details || err.message || err.title || 'falha na entrega' }
              : null,
          });
        }
      } else if (field === 'smb_message_echoes') {
        for (const m of value.message_echoes ?? []) {
          const row = toCloudWaMessage(m, m.to, true, 'app');
          if (row) events.push({ kind: 'echo', phoneNumberId, row });
        }
      } else if (field === 'history') {
        for (const chunk of value.history ?? []) {
          const err = chunk?.errors?.[0];
          const rows: CloudWaRow[] = [];
          for (const thread of chunk?.threads ?? []) {
            const contact = digits(thread?.id);
            for (const m of thread?.messages ?? []) {
              if (!contact) continue;
              const row = toCloudWaMessage(m, contact, digits(m.from) !== contact, 'history');
              if (row) rows.push(row);
            }
          }
          const progress = Number(chunk?.metadata?.progress);
          events.push({
            kind: 'history',
            phoneNumberId,
            rows,
            progress: Number.isFinite(progress) ? progress : null,
            error: err ? `${err.code ?? ''} ${err.error_data?.details || err.message || err.title || ''}`.trim() : null,
          });
        }
      } else if (field === 'smb_app_state_sync') {
        for (const s of value.state_sync ?? []) {
          const phone = digits(s?.contact?.phone_number);
          if (s?.type !== 'contact' || !phone || s.action === 'remove') continue;
          events.push({
            kind: 'contact',
            phoneNumberId,
            contact: {
              jid: `${phone}@s.whatsapp.net`,
              phone,
              phone_key: phoneKey(phone),
              push_name: s.contact.full_name || s.contact.first_name || null,
              profile_pic_url: null,
              is_group: false,
              last_message_at: null,
            },
          });
        }
      } else if (field === 'account_update') {
        events.push({ kind: 'account', wabaId, event: String(value.event ?? ''), phone: digits(value.phone_number) });
      } else if (field === 'phone_number_quality_update') {
        events.push({
          kind: 'quality',
          wabaId,
          phone: digits(value.display_phone_number),
          event: String(value.event ?? ''),
          limit: value.current_limit ?? value.messaging_limit_tier ?? null,
        });
      } else if (field === 'message_template_status_update') {
        events.push({
          kind: 'template',
          wabaId,
          name: String(value.message_template_name ?? ''),
          language: value.message_template_language ?? null,
          event: String(value.event ?? ''),
          reason: value.reason && value.reason !== 'NONE' ? String(value.reason) : null,
        });
      }
    }
  }
  return events;
}
