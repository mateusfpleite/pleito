/**
 * POST /api/export/:jobId (Vercel / Next.js App Router) — production
 * wiring. On-demand PDF export (SPEC §8/§9): analysis relatório or
 * ofício (from the persisted edited text).
 *
 * `runtime='nodejs'` (Prisma + chromium need Node, not Edge). The actual
 * render uses the WORKER container's chromium (RESIDUE: chromium does
 * not exist in Vercel functions; in deploy the engine points to the
 * container's chromium — `/usr/bin/chromium`, see
 * adapters/pdf/render.ts). Testable logic in `./handler.ts` (Next
 * validates the `route.ts` exports).
 */
import { criarPrismaClient } from '../../../../adapters/repo/client.ts';
import { PrismaAnalysisRepo } from '../../../../adapters/repo/analysis.ts';
import { PrismaTelemetry } from '../../../../adapters/repo/telemetry.ts';
import { chromiumPdfEngine } from '../../../../adapters/pdf/render.ts';
import { criarExportPOST, type ExportCtx } from './handler.ts';

export const runtime = 'nodejs';

export async function POST(
  req: Request,
  ctx: ExportCtx
): Promise<Response> {
  const prisma = criarPrismaClient();
  const handler = criarExportPOST({
    analysisRepo: new PrismaAnalysisRepo(prisma),
    pdfEngine: chromiumPdfEngine(),
    telemetry: new PrismaTelemetry(prisma),
  });
  return handler(req, ctx);
}
