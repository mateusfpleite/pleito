/**
 * Lógica testável da rota GET /api/status/:id (fora do `route.ts` —
 * Next.js valida os exports de `route.ts`).
 *
 * SPEC §4/§8: o dashboard faz POLLING aqui. Reflete o estado do Job
 * (`pending | running | done | erro`) e, quando `done`, devolve a análise
 * persistida (extração + ofício). `erro` devolve a mensagem. `id` é o
 * JOB id (a UI nunca conhece o id da Analysis — `buscarPorJobId`).
 */
import type {
  AnalysisRepo,
  JobRepo,
} from '../../../../domain/ports.ts';

export type StatusGetDeps = {
  jobRepo: JobRepo;
  analysisRepo: AnalysisRepo;
};

export type StatusCtx = { params: Promise<{ id: string }> };

export function criarStatusGET(deps: StatusGetDeps) {
  return async function GET(
    _req: Request,
    ctx: StatusCtx
  ): Promise<Response> {
    const { id } = await ctx.params;
    const job = await deps.jobRepo.buscarPorId(id);
    if (!job) {
      return Response.json(
        { erro: `job ${id} não encontrado` },
        { status: 404 }
      );
    }

    if (job.status === 'done') {
      const analise = await deps.analysisRepo.buscarPorJobId(job.id);
      return Response.json({
        status: job.status,
        erro: null,
        resultado: analise
          ? {
              extracao: analise.extracao,
              oficioGerado: analise.oficioGerado,
              municipio: analise.municipio,
              uf: analise.uf,
            }
          : null,
      });
    }

    return Response.json({
      status: job.status,
      erro: job.status === 'erro' ? job.erro : null,
      resultado: null,
    });
  };
}
