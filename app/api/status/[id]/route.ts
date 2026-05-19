/**
 * GET /api/status/:id (Vercel / Next.js App Router) — production wiring.
 *
 * `runtime='nodejs'` (Prisma). Testable logic in `./handler.ts`.
 */
import { criarPrismaClient } from '../../../../adapters/repo/client.ts';
import { PrismaJobRepo } from '../../../../adapters/repo/job.ts';
import { PrismaAnalysisRepo } from '../../../../adapters/repo/analysis.ts';
import { criarStatusGET, type StatusCtx } from './handler.ts';

export const runtime = 'nodejs';

export async function GET(
  req: Request,
  ctx: StatusCtx
): Promise<Response> {
  const prisma = criarPrismaClient();
  const handler = criarStatusGET({
    jobRepo: new PrismaJobRepo(prisma),
    analysisRepo: new PrismaAnalysisRepo(prisma),
  });
  return handler(req, ctx);
}
