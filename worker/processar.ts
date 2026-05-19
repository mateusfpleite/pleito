/**
 * Worker processing loop (SPEC §4 — pipeline in the container).
 *
 * `drenarFila` is the isolated, testable logic: it claims the next job
 * (ATOMIC `FOR UPDATE SKIP LOCKED` claim on `JobRepo`), processes it via
 * `analyzeEdital` (real deps), writes `Analysis` + Job=done; on error →
 * Job=erro with the message and does NOT write a partial doc (the fatal
 * Tier 0 of the workflow already guarantees this; here we only persist the
 * error). After each job it tries `claimNext` again until the queue is
 * empty (drains), then returns.
 *
 * An error in one job does NOT bring down the loop: it is caught, becomes
 * Job=erro, and the next pending job is processed (queue resilience).
 *
 * OBSERVABILITY (SPEC §11b — Phase 15): per job, it collects the cost of
 * EACH grounding call (sink passed to `analyze`), and after writing the
 * Analysis it records: 1 `grounding_custo` event PER call (never just the
 * aggregate — silent cost bomb) + `analise_concluida` with the total
 * latency + the aggregate. ALL telemetry is NON-blocking
 * (`registrarSeguro`): a telemetry failure only logs, never brings down
 * the job.
 */
import type {
  AnalysisRepo,
  ArquivoEntrada,
  JobRepo,
  TelemetryPort,
} from '../domain/ports.ts';
import type { AnalyzeResult } from '../application/analyze-edital.ts';
import { desempacotarInput } from '../infrastructure/input-envelope.ts';
import {
  registrarSeguro,
  payloadAnaliseConcluida,
  payloadGroundingCusto,
  hashInput,
  EVENTO,
} from '../application/telemetria.ts';

/** Usage of ONE grounding call captured during the `analyze`. */
type GroundingUso = {
  lei: string;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
};

export type DrenarDeps = {
  jobRepo: JobRepo;
  analysisRepo: AnalysisRepo;
  /**
   * Runs the pipeline. Receives an OPTIONAL grounding cost sink —
   * called ONCE per real grounding call (the worker uses it to
   * attribute the cost to the analysisId after the save). Test fakes
   * ignore the 2nd arg (backward-compatible signature).
   */
  analyze: (
    input: ArquivoEntrada,
    onGroundingCusto?: (uso: GroundingUso) => void
  ) => Promise<AnalyzeResult>;
  /** NON-blocking telemetry (§11b). Optional: absent = no collection. */
  telemetry?: TelemetryPort;
  /** Injectable clock (deterministic latency in tests). */
  agora?: () => number;
};

export async function drenarFila(deps: DrenarDeps): Promise<void> {
  const agora = deps.agora ?? Date.now;
  for (;;) {
    const job = await deps.jobRepo.claimNext();
    if (!job) return; // queue drained → sleep (scale-to-zero)

    try {
      const input = desempacotarInput(job.inputRef);

      // Grounding cost collector PER job: the sink is called 1x per
      // grounding call; we only know the analysisId after the save, so
      // we accumulate here and write later (attributed to the correct id).
      const groundingUsos: GroundingUso[] = [];
      const inicio = agora();
      const { extracao, oficio } = await deps.analyze(input, (uso) =>
        groundingUsos.push(uso)
      );
      const latenciaMs = agora() - inicio;

      const registro = await deps.analysisRepo.salvar({
        jobId: job.id,
        municipio: extracao.municipio,
        uf: extracao.uf,
        extracao,
        oficioGerado: oficio ?? null,
        // PDF is a derived projection (§9): the ofício is only "exported"
        // when Stefany clicks export (Phase 14) — there is no text yet here.
        oficioExportado: null,
        oficioExportadoEm: null,
      });
      await deps.jobRepo.marcarConcluido(job.id);

      // NON-blocking telemetry, AFTER the job is done (never before —
      // no telemetry may delay/bring down the job completion).
      if (deps.telemetry) {
        const tele = deps.telemetry;
        // SUBMISSION + RE-UPLOAD (§11b): records the input hash. A
        // re-upload of the SAME edital is derivable by grouping
        // `submissao` by `inputHash` (telemetry → eval V1, §11c). The
        // worker has no telemetry query (TelemetryPort is write-only by
        // design); /admin groups by hash and the repeat = re-upload — so
        // her iteration signal is captured without friction.
        const inputHash = hashInput(input.bytes);
        await registrarSeguro(tele, registro.id, EVENTO.submissao, {
          inputHash,
          nomeArquivo: input.nomeArquivo,
        });
        // 1 event PER grounding call (§11b — not just the aggregate).
        let tokensTotais = 0;
        for (const u of groundingUsos) {
          tokensTotais +=
            u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
          await registrarSeguro(
            tele,
            registro.id,
            EVENTO.groundingCusto,
            payloadGroundingCusto(u)
          );
        }
        // analise_concluida — total latency + aggregate cost.
        await registrarSeguro(
          tele,
          registro.id,
          EVENTO.analiseConcluida,
          payloadAnaliseConcluida({
            latenciaMs,
            groundingChamadas: groundingUsos.length,
            groundingTokensTotais: tokensTotais,
            oficioGerado: oficio !== null,
          })
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Does NOT write a partial Analysis — only persists the error on
      // the Job (the fatal Tier 0 of the workflow already aborted before
      // any invalid doc).
      await deps.jobRepo.marcarErro(job.id, msg);
      console.error(`[worker] job ${job.id} → error: ${msg}`);
    }
  }
}
