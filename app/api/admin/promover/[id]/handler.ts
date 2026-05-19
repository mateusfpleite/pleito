/**
 * Lógica testável de POST /api/admin/promover/:id — promote-to-corpus em
 * 1 passo (SPEC §11b). `id` é o analysisId. Botão no /admin → este
 * endpoint → `promoverParaCorpus` grava em `fixtures/gold/`. Read-mostly
 * (escreve só a fixture versionada). Erro de análise inexistente → 404.
 */
import type { AnalysisRepo } from '../../../../../domain/ports.ts';
import {
  promoverParaCorpus,
  type PromoverDeps,
} from '../../../../../application/promover-corpus.ts';

export type PromoverPostDeps = {
  analysisRepo: AnalysisRepo;
  /** Hooks injetáveis p/ teste (escritor/relógio/dir). */
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
