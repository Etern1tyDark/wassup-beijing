import { serve } from '@hono/node-server';
import { app } from './index.ts';

/**
 * Local development entry point for the relay.
 *
 *   MODEL_API_KEY=... MODEL_API_URL=... npm run relay:dev
 *
 * Production deploys the same Hono app as a single serverless function.
 */
const port = Number(process.env['PORT'] ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`relay listening on http://localhost:${String(info.port)}`);
});
