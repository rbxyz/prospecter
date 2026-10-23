function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return value;
}

function list(name: string, fallback: string): string[] {
  return (process.env[name] ?? fallback)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  timezone: process.env.TZ ?? 'America/Sao_Paulo',
  /** APP_DATABASE_URL (banco externo, ex.: Neon) tem prioridade sobre o Postgres local/do compose. */
  databaseUrl: process.env.APP_DATABASE_URL || required('DATABASE_URL'),
  evolution: {
    url: required('EVOLUTION_URL').replace(/\/+$/, ''),
    apiKey: required('EVOLUTION_API_KEY'),
  },
  webhook: {
    url: required('WEBHOOK_URL'),
    token: required('WEBHOOK_TOKEN'),
  },
  panelPassword: process.env.PANEL_PASSWORD ?? '',
  /** URL do painel vista pelo navegador (usada no redirect do OAuth do WatchTower). */
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/+$/, ''),
  watchtower: {
    url: process.env.WATCHTOWER_MCP_URL ?? '',
    /** Opcional: token Bearer fixo. Sem ele, a conexão usa OAuth pelo painel. */
    token: process.env.WATCHTOWER_MCP_TOKEN ?? '',
  },
  /** Cloud API da Meta (números em Coexistência). Sem appSecret, o webhook /webhook/meta recusa tudo. */
  meta: {
    graphVersion: process.env.META_GRAPH_VERSION || 'v24.0',
    /** Segredo do app na Meta: confere a assinatura x-hub-signature-256 de cada webhook. */
    appSecret: process.env.META_APP_SECRET ?? '',
    /** Token escolhido por você e informado na Meta ao cadastrar a URL do webhook. */
    verifyToken: process.env.META_VERIFY_TOKEN ?? '',
  },
  optOut: {
    keywords: list('OPT_OUT_KEYWORDS', 'sair,parar,pare,stop,cancelar,descadastrar,remover'),
    reply: process.env.OPT_OUT_REPLY ?? '',
  },
};
