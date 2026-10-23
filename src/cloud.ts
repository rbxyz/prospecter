import { config } from './config.ts';
import type { CloudParameter, CloudTemplate, MetaTemplate } from './cloud-map.ts';

/** Erro da Graph API, com o código da Meta (ex.: 131026, 131049) para decidir o que fazer. */
export class CloudError extends Error {
  readonly status: number;
  readonly code: number | null;
  readonly body: unknown;
  constructor(status: number, body: any, path: string) {
    const err = body?.error;
    const detail = err ? `${err.code ?? ''} ${err.error_data?.details || err.message || ''}`.trim() : JSON.stringify(body);
    super(`Cloud API ${status} em ${path.split('?')[0]}: ${detail}`);
    this.status = status;
    this.code = Number.isFinite(Number(err?.code)) ? Number(err.code) : null;
    this.body = body;
  }
}

const BASE = 'https://graph.facebook.com';

async function graph<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const url = path.startsWith('https://') ? path : `${BASE}/${config.meta.graphVersion}${path}`;
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // resposta não-JSON; mantém o texto
  }
  if (!res.ok) throw new CloudError(res.status, data, path);
  return data as T;
}

export interface PhoneInfo {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  is_on_biz_app?: boolean;
  platform_type?: string;
}

const enc = encodeURIComponent;

export const cloud = {
  /** Dados do número; is_on_biz_app = true e platform_type = CLOUD_API confirmam a Coex. */
  phoneInfo: async (token: string, phoneNumberId: string): Promise<PhoneInfo> => {
    const base = 'display_phone_number,verified_name,quality_rating';
    try {
      return await graph<PhoneInfo>(token, 'GET', `/${enc(phoneNumberId)}?fields=${base},is_on_biz_app,platform_type`);
    } catch (err) {
      // Versões/contas sem os campos da Coex respondem #100; tenta só com os básicos.
      if (err instanceof CloudError && err.code === 100) return graph<PhoneInfo>(token, 'GET', `/${enc(phoneNumberId)}?fields=${base}`);
      throw err;
    }
  },

  /** Inscreve o app nos webhooks da WABA (idempotente). */
  subscribeApp: (token: string, wabaId: string) => graph(token, 'POST', `/${enc(wabaId)}/subscribed_apps`),

  /** Todos os templates da WABA (segue a paginação). */
  templates: async (token: string, wabaId: string): Promise<MetaTemplate[]> => {
    const all: MetaTemplate[] = [];
    let next: string | undefined =
      `/${enc(wabaId)}/message_templates?fields=name,language,status,category,parameter_format,components&limit=200`;
    while (next) {
      const page: { data?: MetaTemplate[]; paging?: { next?: string } } = await graph(token, 'GET', next);
      all.push(...(page.data ?? []));
      next = page.paging?.next;
    }
    return all;
  },

  sendTemplate: (token: string, phoneNumberId: string, to: string, t: CloudTemplate, parameters: CloudParameter[]) =>
    graph<{ messages?: { id: string }[]; contacts?: { input: string; wa_id: string }[] }>(
      token,
      'POST',
      `/${enc(phoneNumberId)}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'template',
        template: {
          name: t.name,
          language: { code: t.language },
          components: parameters.length ? [{ type: 'body', parameters }] : [],
        },
      },
    ),

  /** Texto livre: só funciona dentro da janela de 24h aberta por uma mensagem do contato. */
  sendText: (token: string, phoneNumberId: string, to: string, text: string) =>
    graph<{ messages?: { id: string }[] }>(token, 'POST', `/${enc(phoneNumberId)}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text, preview_url: true },
    }),

  /**
   * Pede a sincronização da Coex: "smb_app_state_sync" (contatos) ou "history" (até 6 meses, uma vez só).
   * Precisa ser feito nas primeiras 24h após o onboarding; o resultado chega pelos webhooks.
   */
  smbAppData: (token: string, phoneNumberId: string, syncType: 'smb_app_state_sync' | 'history') =>
    graph(token, 'POST', `/${enc(phoneNumberId)}/smb_app_data`, { messaging_product: 'whatsapp', sync_type: syncType }),
};
