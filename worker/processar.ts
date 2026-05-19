/**
 * Laço de processamento do worker (SPEC §4 — pipeline no container).
 *
 * `drenarFila` é a lógica isolada e testável: claima o próximo job
 * (claim ATÔMICO `FOR UPDATE SKIP LOCKED` no `JobRepo`), processa via
 * `analyzeEdital` (deps reais), grava `Analysis` + Job=done; em erro →
 * Job=erro com a mensagem e NÃO grava doc parcial (o Tier 0 fatal do
 * workflow já garante; aqui só persistimos o erro). Após cada job tenta
 * `claimNext` de novo até a fila esvaziar (drena), então retorna.
 *
 * Um erro num job NÃO derruba o laço: é capturado, vira Job=erro, e o
 * próximo pending é processado (resiliência da fila).
 */
import type {
  AnalysisRepo,
  ArquivoEntrada,
  JobRepo,
} from '../domain/ports.ts';
import type { AnalyzeResult } from '../application/analyze-edital.ts';
import { desempacotarInput } from '../infrastructure/input-envelope.ts';

export type DrenarDeps = {
  jobRepo: JobRepo;
  analysisRepo: AnalysisRepo;
  analyze: (input: ArquivoEntrada) => Promise<AnalyzeResult>;
};

export async function drenarFila(deps: DrenarDeps): Promise<void> {
  for (;;) {
    const job = await deps.jobRepo.claimNext();
    if (!job) return; // fila drenada → dorme (scale-to-zero)

    try {
      const input = desempacotarInput(job.inputRef);
      const { extracao, oficio } = await deps.analyze(input);

      await deps.analysisRepo.salvar({
        jobId: job.id,
        municipio: extracao.municipio,
        uf: extracao.uf,
        extracao,
        oficioGerado: oficio ?? null,
        oficioExportado: null,
      });
      await deps.jobRepo.marcarConcluido(job.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // NÃO grava Analysis parcial — só persiste o erro no Job (o Tier 0
      // fatal do workflow já abortou antes de qualquer doc inválido).
      await deps.jobRepo.marcarErro(job.id, msg);
      console.error(`[worker] job ${job.id} → erro: ${msg}`);
    }
  }
}
