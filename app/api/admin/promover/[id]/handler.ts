/**
 * Testable logic for POST /api/admin/promover/:id — one-step
 * promote-to-corpus (SPEC §11b). `id` is the analysisId. Button in
 * /admin → this endpoint → `promoverParaCorpus` writes to
 * `fixtures/gold/`. Read-mostly (writes only the versioned fixture).
 * "Analysis not found" error → 404.
 */
import type { AnalysisRepo } from '../../../../../domain/ports.ts';
import {
  promoverParaCorpus,
  type PromoverDeps,
} from '../../../../../application/promover-corpus.ts';

export type PromoverPostDeps = {
  analysisRepo: AnalysisRepo;
  /** Injectable hooks for testing (writer/clock/dir). */
  promoverOpts?: Omit<PromoverDeps, 'analysisRepo'>;
};

export type PromoverCtx = { params: Promise<{ id: string }> };

export function criarPromoverPOST(deps: PromoverPostDeps) {
  return async function POST(
    _req: Request,
    ctx: PromoverCtx
  ): Promise<Response> {
    const { id } = await ctx.params;
    try {
      const r = await promoverParaCorpus(id, {
        analysisRepo: deps.analysisRepo,
        ...deps.promoverOpts,
      });
      return Response.json(
        { ok: true, nomeArquivo: r.nomeArquivo },
        { status: 201 }
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = /não encontrada/.test(msg) ? 404 : 500;
      return Response.json({ erro: msg }, { status });
    }
  };
}
