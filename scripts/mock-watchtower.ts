/**
 * Servidor MCP falso do WatchTower, para testar a integração sem tocar em dados reais.
 *
 *   node scripts/mock-watchtower.ts            # escuta em http://localhost:4100/mcp, token "mock-token"
 *
 * No .env do Prospecter (app no Docker):
 *   WATCHTOWER_MCP_URL=http://host.docker.internal:4100/mcp
 *   WATCHTOWER_MCP_TOKEN=mock-token
 *
 * GET http://localhost:4100/calls lista as anotações e mudanças de etapa recebidas.
 */
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = Number(process.env.MOCK_PORT ?? 4100);
const TOKEN = process.env.MOCK_TOKEN ?? 'mock-token';

const etapas = [
  { id: '11111111-1111-4111-8111-111111111111', nome: 'Novo', tipo: 'aberta', cor: 'cinza', exigeCliente: false, automacoes: [] },
  { id: '22222222-2222-4222-8222-222222222222', nome: 'Iniciado atendimento', tipo: 'aberta', cor: 'azul', exigeCliente: false, automacoes: [] },
  { id: '33333333-3333-4333-8333-333333333333', nome: 'Proposta', tipo: 'aberta', cor: 'roxo', exigeCliente: false, automacoes: ['criar_orcamento'] },
  { id: '44444444-4444-4444-8444-444444444444', nome: 'Perdido', tipo: 'perdida', cor: 'vermelho', exigeCliente: false, automacoes: [] },
];
const pastas = [
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nome: 'Contabilidades - Lajeado' },
  { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', nome: 'Contabilidades - Estrela' },
];
const prospectos = [
  { id: 'c0000000-0000-4000-8000-000000000001', nome: 'Contábil Alfa LTDA', contatoNome: 'MARIA DA SILVA', telefone: '(51) 3714-0001 / (51) 99900-0001', pastaId: pastas[0].id, etapaId: etapas[0].id },
  { id: 'c0000000-0000-4000-8000-000000000002', nome: 'Beta Contabilidade', contatoNome: 'João Souza', telefone: '(51) 99900-0002', pastaId: pastas[0].id, etapaId: etapas[0].id },
  { id: 'c0000000-0000-4000-8000-000000000003', nome: 'Gama Assessoria', contatoNome: null, telefone: 'sem telefone válido na Receita', pastaId: pastas[1].id, etapaId: etapas[0].id },
  { id: 'c0000000-0000-4000-8000-000000000004', nome: 'Delta Contadores', contatoNome: 'ANA PAULA', telefone: '(51) 3714-0004', pastaId: pastas[1].id, etapaId: etapas[2].id },
].map((p) => ({
  email: null,
  documento: '00000000000191',
  responsavelNome: 'Responsável Teste',
  ...p,
  etapaNome: etapas.find((e) => e.id === p.etapaId)!.nome,
  pastaNome: pastas.find((x) => x.id === p.pastaId)!.nome,
}));

const calls: unknown[] = [];
const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }, { type: 'text' as const, text: 'Empresa: Mock' }] });

function buildServer(): McpServer {
  const server = new McpServer({ name: 'watchtower-mock', version: '0.0.1' });
  server.registerTool('listar_empresas', {}, async () =>
    json({ empresas: [{ id: 'e0000000-0000-4000-8000-000000000000', razaoSocial: 'Mock LTDA', nomeFantasia: 'Mock', cnpj: '0', papel: 'admin' }] }),
  );
  server.registerTool('funil_de_prospeccao', {}, async () =>
    json({ etapas: etapas.map((e) => ({ ...e, prospectos: prospectos.filter((p) => p.etapaId === e.id).length })) }),
  );
  server.registerTool('listar_pastas_de_prospectos', {}, async () =>
    json(pastas.map((x) => ({ ...x, prospectos: prospectos.filter((p) => p.pastaId === x.id).length }))),
  );
  server.registerTool(
    'listar_prospectos',
    { inputSchema: { situacao: z.string().optional(), etapaId: z.string().optional(), pastaId: z.string().optional(), busca: z.string().optional() } },
    async (args) =>
      json(
        prospectos.filter(
          (p) =>
            (!args.etapaId || p.etapaId === args.etapaId) &&
            (!args.pastaId || p.pastaId === args.pastaId) &&
            (!args.busca || JSON.stringify(p).toLowerCase().includes(args.busca.toLowerCase())),
        ),
      ),
  );
  server.registerTool('obter_prospecto', { inputSchema: { id: z.string() } }, async ({ id }) => {
    const p = prospectos.find((x) => x.id === id);
    if (!p) return { isError: true, content: [{ type: 'text', text: 'Prospecto não encontrado' }] };
    return json({ prospecto: p, etapa: etapas.find((e) => e.id === p.etapaId) });
  });
  server.registerTool('anotar_no_prospecto', { inputSchema: { id: z.string(), texto: z.string() } }, async (args) => {
    calls.push({ tool: 'anotar_no_prospecto', ...args });
    return json({ ok: true });
  });
  server.registerTool('mover_prospecto', { inputSchema: { id: z.string(), etapaId: z.string() } }, async (args) => {
    const p = prospectos.find((x) => x.id === args.id);
    if (p) {
      p.etapaId = args.etapaId;
      p.etapaNome = etapas.find((e) => e.id === args.etapaId)!.nome;
    }
    calls.push({ tool: 'mover_prospecto', ...args });
    return json({ ok: true, automacoes: [] });
  });
  return server;
}

createServer(async (req, res) => {
  if (req.url === '/calls') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(calls, null, 2));
  }
  if (!req.url?.startsWith('/mcp')) return res.writeHead(404).end();
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end('unauthorized');

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;

  // Modo sem sessão: um servidor/transporte por requisição.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}).listen(PORT, () => console.log(`[mock-watchtower] http://localhost:${PORT}/mcp (token: ${TOKEN})`));
