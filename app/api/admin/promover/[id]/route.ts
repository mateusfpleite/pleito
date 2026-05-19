/**
 * POST /api/admin/promover/:id (Vercel / Next.js App Router) — wiring de
 * produção do promote-to-corpus em 1 passo (SPEC §11b). `runtime='nodejs'`
 * (Prisma + escrita em `fixtures/gold/`). Lógica testável em `./handler.ts`.
 */
import { criarPrismaClient } from '../../../../../adapters/repo/client.ts';
import { PrismaAnalysisRepo } from '../../../../../adapters/repo/analysis.ts';
import { criarPromoverPOST, type PromoverCtx } from './handler.ts';

export const runtime = 'nodejs';

export async function POST(
  req: Request,
  ctx: PromoverCtx
): Promise<Response> {
  const handler = criarPromoverPOST({
    analysisRepo: new PrismaAnalysisRepo(criarPrismaClient()),
  });
  return handler(req, ctx);
}
