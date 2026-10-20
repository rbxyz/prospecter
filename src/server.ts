import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { config } from './config.ts';
import { migrate } from './db.ts';
import { EvolutionError } from './evolution.ts';
import { syncWebhooks } from './instances.ts';
import { registerRoutes } from './routes.ts';
import { startWaSync } from './wa-sync.ts';
import { startOutbox } from './watchtower.ts';
import { startWorker } from './worker.ts';

const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 20 * 1024 * 1024 });

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Basic Auth no painel e na API (o webhook usa o próprio token).
if (config.panelPassword) {
  const expected = 'Basic ' + Buffer.from(`admin:${config.panelPassword}`).toString('base64');
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/webhook/') || req.url === '/health') return;
    if (!safeEqual(req.headers.authorization ?? '', expected)) {
      return reply.code(401).header('www-authenticate', 'Basic realm="Prospecter"').send('Autenticação necessária');
    }
  });
}

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof EvolutionError) {
    return reply.code(502).send({ error: err.message, evolution: err.body });
  }
  const error = err as Error & { statusCode?: number };
  const status = error.statusCode ?? 500;
  if (status >= 500) console.error(error);
  return reply.code(status).send({ error: error.message });
});

await migrate();
await app.register(fastifyStatic, { root: fileURLToPath(new URL('../public/', import.meta.url)) });
await registerRoutes(app);
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`[server] Prospecter em http://localhost:${config.port}`);

// A Evolution pode demorar para subir junto com o compose: tenta sincronizar os webhooks por alguns minutos.
(async () => {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await syncWebhooks();
      return;
    } catch (err) {
      if (attempt === 1) console.warn('[server] aguardando a Evolution API para sincronizar webhooks:', (err as Error).message);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  console.error('[server] não foi possível sincronizar os webhooks com a Evolution API');
})();
startWorker();
startOutbox();
startWaSync();
