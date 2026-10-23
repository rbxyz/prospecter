import { randomBytes } from 'node:crypto';
import { auth, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { config } from './config.ts';
import { sql } from './db.ts';
import { kvDelete, kvGet, kvSet } from './kv.ts';
import { matchesCnae, parseToolText, type CnaeFilter, type WtProspect } from './watchtower-map.ts';

/**
 * Integração com o WatchTower via MCP (Streamable HTTP).
 * Autenticação: OAuth 2.1 com registro dinâmico de cliente (o mesmo fluxo do conector do claude.ai)
 * ou, se WATCHTOWER_MCP_TOKEN estiver definido, um token Bearer fixo.
 */

export interface WtSettings {
  empresaId: string | null;
  annotateSends: boolean;
  /** Mover o prospecto de etapa (de moveFromStageId para moveToStageId)... */
  moveEnabled: boolean;
  /** ...quando a mensagem é enviada ou quando o contato responde pela primeira vez. */
  moveTrigger: 'send' | 'reply';
  moveFromStageId: string | null;
  moveToStageId: string | null;
}

export interface WtStage {
  id: string;
  nome: string;
  tipo: 'aberta' | 'ganha' | 'perdida';
  exigeCliente: boolean;
  automacoes: string[];
  prospectos: number;
}

const DEFAULT_SETTINGS: WtSettings = {
  empresaId: null,
  annotateSends: true,
  moveEnabled: true,
  moveTrigger: 'send',
  moveFromStageId: null,
  moveToStageId: null,
};

const KEY = {
  client: 'watchtower.oauth.client',
  tokens: 'watchtower.oauth.tokens',
  verifier: 'watchtower.oauth.verifier',
  state: 'watchtower.oauth.state',
  settings: 'watchtower.settings',
};

export const isConfigured = (): boolean => Boolean(config.watchtower.url);

export async function getSettings(): Promise<WtSettings> {
  // Versões anteriores guardavam só "moveOnReply" (mover ao responder).
  const { moveOnReply, ...stored } = (await kvGet<Partial<WtSettings> & { moveOnReply?: boolean }>(KEY.settings)) ?? {};
  const legacy = moveOnReply !== undefined && stored.moveEnabled === undefined ? { moveEnabled: moveOnReply } : {};
  return { ...DEFAULT_SETTINGS, ...legacy, ...stored };
}

export async function saveSettings(patch: Partial<WtSettings>): Promise<WtSettings> {
  const settings = { ...(await getSettings()), ...patch };
  await kvSet(KEY.settings, settings);
  await enqueueMovesForSent(settings);
  return settings;
}

/**
 * Com "mover no envio", garante que todo prospecto que já recebeu mensagem tenha a mudança de
 * etapa na fila (inclusive os enviados antes de a opção existir). Idempotente; o processamento
 * da fila só move quem ainda está na etapa de origem.
 */
export async function enqueueMovesForSent(settings?: WtSettings): Promise<number> {
  const s = settings ?? (await getSettings());
  if (!s.moveEnabled || s.moveTrigger !== 'send' || !s.moveFromStageId || !s.moveToStageId) return 0;
  const res = await sql`
    INSERT INTO watchtower_outbox (kind, prospect_id, payload)
    SELECT DISTINCT 'move', c.wt_prospect_id,
           jsonb_build_object('fromStageId', ${s.moveFromStageId}::text, 'toStageId', ${s.moveToStageId}::text)
    FROM messages m JOIN contacts c ON c.id = m.contact_id
    WHERE m.status = 'sent' AND c.wt_prospect_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM watchtower_outbox o
        WHERE o.kind = 'move' AND o.prospect_id = c.wt_prospect_id AND o.payload->>'toStageId' = ${s.moveToStageId}::text
      )`;
  if (res.count) console.log(`[watchtower] ${res.count} mudança(s) de etapa enfileiradas para prospectos já contatados`);
  return res.count;
}

// ---------- OAuth ----------

/** URL de autorização capturada durante `auth()`, para o painel abrir no navegador. */
let pendingAuthUrl: URL | null = null;

class DbOAuthProvider implements OAuthClientProvider {
  get redirectUrl(): string {
    return `${config.publicUrl}/integrations/watchtower/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Prospecter',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      // "acoes" é necessário para anotar e mover prospectos; "leitura" para listar.
      scope: 'leitura acoes',
    };
  }

  async state(): Promise<string> {
    const state = randomBytes(16).toString('hex');
    await kvSet(KEY.state, state);
    return state;
  }

  clientInformation = () => kvGet<OAuthClientInformationMixed>(KEY.client);
  saveClientInformation = (info: OAuthClientInformationMixed) => kvSet(KEY.client, info);
  tokens = () => kvGet<OAuthTokens>(KEY.tokens);
  saveTokens = (tokens: OAuthTokens) => kvSet(KEY.tokens, tokens);
  saveCodeVerifier = (verifier: string) => kvSet(KEY.verifier, verifier);

  async codeVerifier(): Promise<string> {
    const verifier = await kvGet<string>(KEY.verifier);
    if (!verifier) throw new Error('Fluxo OAuth sem code verifier; clique em Conectar novamente');
    return verifier;
  }

  redirectToAuthorization(url: URL): void {
    pendingAuthUrl = url;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all') await kvDelete(KEY.client, KEY.tokens, KEY.verifier);
    if (scope === 'client') await kvDelete(KEY.client);
    if (scope === 'tokens') await kvDelete(KEY.tokens);
    if (scope === 'verifier') await kvDelete(KEY.verifier);
  }
}

const provider = new DbOAuthProvider();

/** Inicia a autorização. Retorna a URL que o usuário deve abrir, ou null se já estiver autorizado. */
export async function startAuthorization(): Promise<string | null> {
  if (!isConfigured()) throw new Error('Defina WATCHTOWER_MCP_URL no .env');
  if (config.watchtower.token) {
    // Token fixo: não há OAuth, só confirma que a conexão funciona.
    await resetClient();
    await callTool('listar_empresas');
    return null;
  }
  pendingAuthUrl = null;
  const result = await auth(provider, { serverUrl: config.watchtower.url });
  await resetClient();
  return result === 'REDIRECT' ? (pendingAuthUrl as URL | null)?.toString() ?? null : null;
}

export async function finishAuthorization(code: string, state: string | undefined): Promise<void> {
  const expected = await kvGet<string>(KEY.state);
  if (expected && state !== expected) throw new Error('state OAuth inválido; tente conectar de novo');
  await auth(provider, { serverUrl: config.watchtower.url, authorizationCode: code });
  await kvDelete(KEY.state, KEY.verifier);
  await resetClient();
}

export async function disconnect(): Promise<void> {
  await kvDelete(KEY.client, KEY.tokens, KEY.verifier, KEY.state);
  await resetClient();
}

// ---------- Cliente MCP ----------

let client: Client | null = null;
let connecting: Promise<Client> | null = null;

async function resetClient(): Promise<void> {
  const current = client;
  client = null;
  connecting = null;
  await current?.close().catch(() => {});
}

async function getClient(): Promise<Client> {
  if (client) return client;
  if (!isConfigured()) throw new Error('Integração com o WatchTower não configurada (WATCHTOWER_MCP_URL)');
  connecting ??= (async () => {
    const transport = new StreamableHTTPClientTransport(new URL(config.watchtower.url), {
      ...(config.watchtower.token
        ? { requestInit: { headers: { authorization: `Bearer ${config.watchtower.token}` } } }
        : { authProvider: provider }),
    });
    const c = new Client({ name: 'prospecter', version: '0.1.0' });
    try {
      await c.connect(transport);
    } catch (err) {
      connecting = null;
      throw err;
    }
    client = c;
    return c;
  })();
  return connecting;
}

export class WatchTowerAuthError extends Error {
  statusCode = 409;
}

/** Chama uma ferramenta do WatchTower e devolve o JSON da resposta. Reconecta uma vez se a sessão caiu. */
export async function callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const settings = await getSettings();
  const finalArgs = settings.empresaId && name !== 'listar_empresas' ? { empresaId: settings.empresaId, ...args } : args;

  for (let attempt = 1; ; attempt++) {
    try {
      const c = await getClient();
      const res = await c.callTool({ name, arguments: finalArgs }, undefined, { timeout: 120_000 });
      const data = parseToolText(res.content);
      if (res.isError) throw new Error(typeof data === 'string' ? data : JSON.stringify(data));
      return data as T;
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        await resetClient();
        throw new WatchTowerAuthError('WatchTower não autorizado: conecte a conta na aba WatchTower');
      }
      const message = (err as Error).message ?? '';
      const sessionLost = /session|404|ECONNRESET|fetch failed|closed/i.test(message);
      if (attempt >= 2 || !sessionLost) throw err;
      await resetClient();
    }
  }
}

export interface WtStatus {
  configured: boolean;
  url: string | null;
  authMode: 'oauth' | 'token';
  connected: boolean;
  error: string | null;
  empresas: { id: string; nomeFantasia: string | null; razaoSocial: string; papel: string }[];
  settings: WtSettings;
}

export async function getStatus(): Promise<WtStatus> {
  const settings = await getSettings();
  const base = {
    configured: isConfigured(),
    url: config.watchtower.url || null,
    authMode: config.watchtower.token ? ('token' as const) : ('oauth' as const),
    settings,
  };
  if (!base.configured) return { ...base, connected: false, error: null, empresas: [] };
  if (!config.watchtower.token && !(await provider.tokens())) {
    return { ...base, connected: false, error: null, empresas: [] };
  }
  try {
    const { empresas } = await callTool<{ empresas: WtStatus['empresas'] }>('listar_empresas');
    return { ...base, connected: true, error: null, empresas };
  } catch (err) {
    return { ...base, connected: false, error: (err as Error).message, empresas: [] };
  }
}

/** Na primeira conexão, sugere "primeira etapa → segunda etapa" do funil para mover quem responde. */
export async function ensureDefaultStages(): Promise<void> {
  const settings = await getSettings();
  if (settings.moveFromStageId && settings.moveToStageId) return;
  const { etapas } = await callTool<{ etapas: WtStage[] }>('funil_de_prospeccao');
  const [from, to] = etapas;
  if (from?.tipo === 'aberta' && to?.tipo === 'aberta' && to.automacoes.length === 0 && !to.exigeCliente) {
    await saveSettings({ moveFromStageId: from.id, moveToStageId: to.id });
  }
}

export async function listProspects(filters: {
  pastaIds?: string[];
  etapaId?: string;
  situacao?: string;
  busca?: string;
  cnae?: CnaeFilter;
}): Promise<WtProspect[]> {
  const base: Record<string, unknown> = { situacao: filters.situacao || 'abertos' };
  if (filters.etapaId) base.etapaId = filters.etapaId;
  if (filters.busca) base.busca = filters.busca;
  const pastas = filters.pastaIds?.length ? filters.pastaIds : [null];

  const byId = new Map<string, WtProspect>();
  for (const pastaId of pastas) {
    const list = await callTool<WtProspect[]>('listar_prospectos', pastaId ? { ...base, pastaId } : base);
    for (const p of Array.isArray(list) ? list : []) if (matchesCnae(p, filters.cnae)) byId.set(p.id, p);
  }
  return [...byId.values()];
}

// ---------- Escrita no WatchTower (fila) ----------

export async function enqueueNote(prospectId: string, texto: string): Promise<void> {
  await sql`INSERT INTO watchtower_outbox (kind, prospect_id, payload) VALUES ('note', ${prospectId}, ${sql.json({ texto })})`;
}

export async function enqueueMove(prospectId: string, fromStageId: string, toStageId: string): Promise<void> {
  await sql`
    INSERT INTO watchtower_outbox (kind, prospect_id, payload)
    VALUES ('move', ${prospectId}, ${sql.json({ fromStageId, toStageId })})`;
}

const MAX_OUTBOX_ATTEMPTS = 5;
let processing = false;

async function processOutbox(): Promise<void> {
  if (processing || !isConfigured()) return;
  processing = true;
  try {
    const items = await sql<{ id: number; kind: 'note' | 'move'; prospect_id: string; payload: any; attempts: number }[]>`
      SELECT id, kind, prospect_id, payload, attempts FROM watchtower_outbox
      WHERE status = 'pending' ORDER BY id LIMIT 20`;
    for (const item of items) {
      try {
        let status: 'done' | 'skipped' = 'done';
        let note: string | null = null;
        if (item.kind === 'note') {
          await callTool('anotar_no_prospecto', { id: item.prospect_id, texto: item.payload.texto });
        } else {
          // Só move se o prospecto ainda estiver na etapa de origem (nunca "volta" alguém que já avançou).
          const current = await callTool<{ prospecto: { etapaId: string }; etapa: { nome: string } }>('obter_prospecto', {
            id: item.prospect_id,
          });
          if (current.prospecto.etapaId !== item.payload.fromStageId) {
            status = 'skipped';
            note = `prospecto já estava em "${current.etapa?.nome}"`;
          } else {
            await callTool('mover_prospecto', { id: item.prospect_id, etapaId: item.payload.toStageId });
          }
        }
        await sql`UPDATE watchtower_outbox SET status = ${status}, error = ${note}, done_at = now() WHERE id = ${item.id}`;
      } catch (err) {
        // Sem autorização, a fila espera a reconexão sem gastar tentativas.
        if (err instanceof WatchTowerAuthError) return;
        const attempts = item.attempts + 1;
        await sql`
          UPDATE watchtower_outbox
          SET attempts = ${attempts}, error = ${(err as Error).message.slice(0, 500)},
              status = ${attempts >= MAX_OUTBOX_ATTEMPTS ? 'failed' : 'pending'}
          WHERE id = ${item.id}`;
      }
    }
  } catch (err) {
    console.warn('[watchtower] erro ao processar a fila:', (err as Error).message);
  } finally {
    processing = false;
  }
}

export function startOutbox(): void {
  enqueueMovesForSent().catch((err) => console.warn('[watchtower] falha ao enfileirar mudanças de etapa:', err.message));
  setInterval(() => void processOutbox(), 10_000);
}

export async function outboxSummary() {
  const counts = await sql<{ status: string; count: number }[]>`
    SELECT status, count(*)::int AS count FROM watchtower_outbox GROUP BY status`;
  const failures = await sql`
    SELECT id, kind, prospect_id, error, attempts, created_at FROM watchtower_outbox
    WHERE status = 'failed' ORDER BY id DESC LIMIT 20`;
  return { counts: Object.fromEntries(counts.map((c) => [c.status, c.count])), failures };
}

export async function retryFailedOutbox(): Promise<number> {
  const res = await sql`UPDATE watchtower_outbox SET status = 'pending', attempts = 0 WHERE status = 'failed'`;
  return res.count;
}
