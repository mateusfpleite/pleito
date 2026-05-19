/**
 * GET /api/admin/list (Vercel / Next.js App Router) — dados da superfície
 * de revisão interna `/admin` (SPEC §11b). `runtime='nodejs'` (Prisma).
 * Lógica em `app/admin/handler.ts` (`listarAdmin`). Read-only; fica sob a
 * mesma proteção da auth global (Phase 16).
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
