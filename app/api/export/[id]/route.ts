/**
 * POST /api/export/:jobId (Vercel / Next.js App Router) — wiring de
 * produção. Export PDF on-demand (SPEC §8/§9): relatório da análise ou
 * ofício (a partir do texto editado persistido).
 *
 * `runtime='nodejs'` (Prisma + chromium precisam de Node, não Edge). A
 * render real usa o chromium do WORKER container (RESÍDUO: chromium não
 * existe nas funções Vercel; em deploy o engine aponta pro chromium do
 * container — `/usr/bin/chromium`, ver adapters/pdf/render.ts). Lógica
 * testável em `./handler.ts` (Next valida os exports de `route.ts`).
 */
import { criarPrismaClient } from '../../../../adapters/repo/client.ts';
import { PrismaAnalysisRepo } from '../../../../adapters/repo/analysis.ts';
import { chromiumPdfEngine } from '../../../../adapters/pdf/render.ts';
import { criarExportPOST, type ExportCtx } from './handler.ts';

export const runtime = 'nodejs';

export async function POST(
  req: Request,
  ctx: ExportCtx
): Promise<Response> {
  const handler = criarExportPOST({
    analysisRepo: new PrismaAnalysisRepo(criarPrismaClient()),
    pdfEngine: chromiumPdfEngine(),
  });
  return handler(req, ctx);
}
