/**
 * POST /api/login (Next.js App Router) — wiring de produção da auth
 * single-user (SPEC §14, #7). `runtime='nodejs'` (usa
 * `crypto.timingSafeEqual` do Node p/ a comparação da senha em tempo
 * constante). Lógica testável em `./handler.ts`.
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
