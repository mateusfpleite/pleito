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
 *
 * OBSERVABILIDADE (SPEC §11b — Phase 15): por job, coleta o custo de CADA
 * chamada de grounding (sink passado ao `analyze`), e após gravar a
 * Analysis registra: 1 evento `grounding_custo` POR chamada (nunca só
 * agregado — bomba de custo silenciosa) + `analise_concluida` com a
 * latência total + o agregado. TODA telemetria é NÃO-bloqueante
 * (`registrarSeguro`): falha de telemetria só loga, jamais derruba o job.
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

/** Uso de UMA chamada de grounding capturada durante o `analyze`. */
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
   * Roda o pipeline. Recebe um sink OPCIONAL de custo de grounding —
   * chamado UMA vez por chamada de grounding real (o worker o usa para
   * atribuir o custo ao analysisId após o save). Fakes de teste ignoram
   * o 2º arg (assinatura retrocompatível).
   */
  analyze: (
    input: ArquivoEntrada,
    onGroundingCusto?: (uso: GroundingUso) => void
  ) => Promise<AnalyzeResult>;
  /** Telemetria NÃO-bloqueante (§11b). Opcional: ausente = sem coleta. */
  telemetry?: TelemetryPort;
  /** Relógio injetável (latência determinística nos testes). */
  agora?: () => number;
};

export async function drenarFila(deps: DrenarDeps): Promise<void> {
  const agora = deps.agora ?? Date.now;
  for (;;) {
    const job = await deps.jobRepo.claimNext();
    if (!job) return; // fila drenada → dorme (scale-to-zero)

    try {
      const input = desempacotarInput(job.inputRef);

      // Coletor de custo de grounding POR job: o sink é chamado 1x por
      // chamada de grounding; só sabemos o analysisId após o save, então
      // acumulamos aqui e gravamos depois (atribuído ao id correto).
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
        // PDF é projeção derivada (§9): o ofício só é "exportado" quando
        // a Stefany clica exportar (Phase 14) — aqui ainda não há texto.
        oficioExportado: null,
        oficioExportadoEm: null,
      });
      await deps.jobRepo.marcarConcluido(job.id);

      // Telemetria NÃO-bloqueante, DEPOIS do job concluído (nunca antes —
      // nada de telemetria pode atrasar/derrubar a conclusão do job).
      if (deps.telemetry) {
        const tele = deps.telemetry;
        // SUBMISSÃO + RE-UPLOAD (§11b): grava o hash do input. Re-upload
        // do MESMO edital é derivável agrupando `submissao` por
        // `inputHash` (telemetria → eval V1, §11c). O worker não tem
        // query de telemetria (TelemetryPort é write-only por design);
        // a /admin agrupa por hash e o repete = re-upload — assim o
        // sinal de iteração dela é capturado sem fricção.
        const inputHash = hashInput(input.bytes);
        await registrarSeguro(tele, registro.id, EVENTO.submissao, {
          inputHash,
          nomeArquivo: input.nomeArquivo,
        });
        // 1 evento POR chamada de grounding (§11b — não só agregado).
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
        // analise_concluida — latência total + custo agregado.
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
      // NÃO grava Analysis parcial — só persiste o erro no Job (o Tier 0
      // fatal do workflow já abortou antes de qualquer doc inválido).
      await deps.jobRepo.marcarErro(job.id, msg);
      console.error(`[worker] job ${job.id} → erro: ${msg}`);
    }
  }
}
