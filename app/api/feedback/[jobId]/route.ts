/**
 * POST /api/feedback/:jobId (Vercel / Next.js App Router) — production
 * wiring. Minimal explicit feedback (SPEC §11b). `runtime='nodejs'`
 * (Prisma). Testable logic in `./handler.ts`.
 */
import { criarPrismaClient } from '../../../../adapters/repo/client.ts';
import { PrismaAnalysisRepo } from '../../../../adapters/repo/analysis.ts';
import { PrismaTelemetry } from '../../../../adapters/repo/telemetry.ts';
import { criarFeedbackPOST, type FeedbackCtx } from './handler.ts';

export const runtime = 'nodejs';

export async function POST(
  req: Request,
  ctx: FeedbackCtx
): Promise<Response> {
  const prisma = criarPrismaClient();
  const handler = criarFeedbackPOST({
    analysisRepo: new PrismaAnalysisRepo(prisma),
    telemetry: new PrismaTelemetry(prisma),
  });
  return handler(req, ctx);
}
