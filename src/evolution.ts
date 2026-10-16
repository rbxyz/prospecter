import { config } from './config.ts';

export class EvolutionError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, path: string) {
    super(`Evolution API ${status} em ${path}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(config.evolution.url + path, {
    method,
    headers: { apikey: config.evolution.apiKey, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // resposta não-JSON; mantém o texto
  }
  if (!res.ok) throw new EvolutionError(res.status, data, path);
  return data as T;
}

const enc = encodeURIComponent;

export type ConnectionState = 'open' | 'connecting' | 'close';

export interface EvolutionInstance {
  name: string;
  connectionStatus: ConnectionState;
  ownerJid: string | null;
  profileName: string | null;
  profilePicUrl: string | null;
}

export interface QrCode {
  pairingCode?: string | null;
  code?: string;
  base64?: string;
  count?: number;
}

export const evolution = {
  fetchInstances: () => request<EvolutionInstance[]>('GET', '/instance/fetchInstances'),

  createInstance: (instanceName: string) =>
    request<{ qrcode?: QrCode }>('POST', '/instance/create', {
      instanceName,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
      groupsIgnore: true,
      rejectCall: false,
      alwaysOnline: false,
      readMessages: false,
    }),

  setWebhook: (instanceName: string) =>
    request('POST', `/webhook/set/${enc(instanceName)}`, {
      webhook: {
        enabled: true,
        url: config.webhook.url,
        headers: { 'x-prospecter-token': config.webhook.token },
        byEvents: false,
        base64: false,
        events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
      },
    }),

  /** Retorna o QR Code (ou pairingCode quando `number` é informado). */
  connect: (instanceName: string, number?: string) =>
    request<QrCode & { instance?: { state: ConnectionState } }>(
      'GET',
      `/instance/connect/${enc(instanceName)}${number ? `?number=${enc(number)}` : ''}`,
    ),

  connectionState: async (instanceName: string): Promise<ConnectionState> => {
    const res = await request<{ instance: { state?: ConnectionState } }>(
      'GET',
      `/instance/connectionState/${enc(instanceName)}`,
    );
    return res.instance?.state ?? 'close';
  },

  logout: (instanceName: string) => request('DELETE', `/instance/logout/${enc(instanceName)}`),

  deleteInstance: (instanceName: string) => request('DELETE', `/instance/delete/${enc(instanceName)}`),

  /** Confere se os números têm WhatsApp e devolve o JID correto (resolve o 9º dígito). */
  whatsappNumbers: (instanceName: string, numbers: string[]) =>
    request<{ exists: boolean; jid: string; number: string }[]>(
      'POST',
      `/chat/whatsappNumbers/${enc(instanceName)}`,
      { numbers },
    ),

  /** `delay` (ms) mostra "digitando..." antes de enviar. */
  sendText: (instanceName: string, number: string, text: string, delayMs = 0) =>
    request<{ key?: { id?: string } }>('POST', `/message/sendText/${enc(instanceName)}`, {
      number,
      text,
      delay: delayMs,
      linkPreview: true,
    }),
};
