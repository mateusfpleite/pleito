/**
 * GET /api/admin/list (Vercel / Next.js App Router) — data for the
 * internal `/admin` review surface (SPEC §11b). `runtime='nodejs'`
 * (Prisma). Logic in `app/admin/handler.ts` (`listarAdmin`). Read-only;
 * sits under the global auth protection (Phase 16).
 */
import { criarPrismaClient } from '../../../../adapters/repo/client.ts';
import { PrismaAnalysisRepo } from '../../../../adapters/repo/analysis.ts';
import { PrismaTelemetry } from '../../../../adapters/repo/telemetry.ts';
import { listarAdmin } from '../../../admin/handler.ts';

export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  const prisma = criarPrismaClient();
  const linhas = await listarAdmin({
    analysisRepo: new PrismaAnalysisRepo(prisma),
    telemetry: new PrismaTelemetry(prisma),
  });
  return Response.json({ linhas });
}
