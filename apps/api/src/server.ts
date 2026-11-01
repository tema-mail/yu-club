import Fastify, { type FastifyInstance } from 'fastify';
import { pathToFileURL } from 'node:url';
import { loadConfig, type Config } from './config.ts';

export function buildServer(config: Config): FastifyInstance {
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });

  app.get('/health', async () => ({ status: 'ok', version: config.GIT_SHA }));

  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = buildServer(config);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  }
  await app.listen({ host: config.HOST, port: config.PORT });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
