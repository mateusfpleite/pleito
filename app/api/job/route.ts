/**
 * POST /api/job (Vercel / Next.js App Router) — production wiring.
 *
 * `runtime='nodejs'` (Prisma needs Node, not Edge); pooled DATABASE_URL
 * (pgBouncer) configured in deploy (RESIDUE). The testable logic is in
 * `./handler.ts` (Next validates the `route.ts` exports).
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
