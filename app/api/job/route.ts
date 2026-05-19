/**
 * POST /api/job (Vercel / Next.js App Router) — wiring de produção.
 *
 * `runtime='nodejs'` (Prisma precisa de Node, não Edge); DATABASE_URL
 * pooled (pgBouncer) configurado no deploy (RESÍDUO). A lógica testável
 * está em `./handler.ts` (Next valida os exports de `route.ts`).
 */
import { getConfig } from '../../../infrastructure/config.ts';
import { criarPrismaClient } from '../../../adapters/repo/client.ts';
import { PrismaJobRepo } from '../../../adapters/repo/job.ts';
import { criarJobPOST } from './handler.ts';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const cfg = getConfig();
  const handler = criarJobPOST({
    jobRepo: new PrismaJobRepo(criarPrismaClient()),
    workerUrl: cfg.WORKER_URL,
    fetchImpl: fetch,
  });
  return handler(req);
}
