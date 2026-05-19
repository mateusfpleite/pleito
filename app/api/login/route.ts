/**
 * POST /api/login (Next.js App Router) — production wiring of the
 * single-user auth (SPEC §14, #7). `runtime='nodejs'` (uses Node's
 * `crypto.timingSafeEqual` for the constant-time password comparison).
 * Testable logic in `./handler.ts`.
 */
import { getConfig } from '../../../infrastructure/config.ts';
import { criarLoginPOST } from './handler.ts';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const config = getConfig();
  const handler = criarLoginPOST({
    appSecret: config.APP_SECRET,
    producao: process.env.NODE_ENV === 'production',
  });
  return handler(req);
}
