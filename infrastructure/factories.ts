/**
 * Composição da infraestrutura (hexagonal) — único lugar que monta os
 * ADAPTERS CONCRETOS e os injeta no `application/`. O domínio e a aplicação
 * nunca conhecem Gemini/Prisma; aqui o boundary é fechado.
 *
 * - `montarRepos(prisma)`: os 4 repos Prisma sobre um `PrismaClientLike`
 *   (produção: `criarPrismaClient()`; testes: fake estrutural).
 * - `montarAnalyzeDeps({ model?, normaCache })`: o `AnalyzeDeps` do
 *   workflow com os adapters Gemini reais (extractor/verifier/risk/drafter)
 *   + Preprocessor. `model` é injetável (testes passam fake — não resolve
 *   API key); em produção cada adapter resolve `google(config.MODEL)`
 *   preguiçosamente se nenhum for passado.
 *
 * O worker (Phase 12) chama `criarPrismaClient()` → `montarRepos` →
 * `montarAnalyzeDeps` e roda `analyzeEdital`.
 */
import type { LanguageModel } from 'ai';
import type { AnalyzeDeps } from '../application/analyze-edital.ts';
import type {
  AnalysisRepo,
  JobRepo,
  NormaCache,
  TelemetryPort,
} from '../domain/ports.ts';
import { Preprocessor } from '../adapters/pdf/preprocessor.ts';
import { GeminiExtractor } from '../adapters/extractor/gemini.ts';
import {
  GeminiNormaVerifier,
  type GroundingCustoSink,
} from '../adapters/verifier/gemini.ts';
import { GeminiRiskAnalyst } from '../adapters/risk-analyst/gemini.ts';
import { GeminiDrafter } from '../adapters/drafter/gemini.ts';
import { PrismaJobRepo } from '../adapters/repo/job.ts';
import { PrismaAnalysisRepo } from '../adapters/repo/analysis.ts';
import { PrismaNormaCache } from '../adapters/repo/norma-cache.ts';
import { PrismaTelemetry } from '../adapters/repo/telemetry.ts';
import {
  criarPrismaClient,
  type PrismaClientLike,
} from '../adapters/repo/client.ts';

/** Repos Prisma montados sobre um único client (boundary de persistência). */
export type Repos = {
  jobRepo: JobRepo;
  analysisRepo: AnalysisRepo;
  normaCache: NormaCache;
  telemetry: TelemetryPort;
};

/** Monta os 4 repos Prisma sobre o client injetado (default: produção). */
export function montarRepos(
  prisma: PrismaClientLike = criarPrismaClient()
): Repos {
  return {
    jobRepo: new PrismaJobRepo(prisma),
    analysisRepo: new PrismaAnalysisRepo(prisma),
    normaCache: new PrismaNormaCache(prisma),
    telemetry: new PrismaTelemetry(prisma),
  };
}

/**
 * Monta o `AnalyzeDeps` com os adapters Gemini reais + Preprocessor.
 * `model` opcional (injetável p/ teste). `normaCache` é obrigatório — o
 * Verifier precisa do cache real (vem de `montarRepos`).
 */
export function montarAnalyzeDeps(opts: {
  model?: LanguageModel;
  normaCache: NormaCache;
  /**
   * Sink OPCIONAL de custo de grounding POR chamada (SPEC §11b). O worker
   * injeta um coletor por-job (acumula e grava telemetria após o save,
   * com o analysisId real); ausente = no-op (não há instrumentação fora
   * do worker).
   */
  onGroundingCusto?: GroundingCustoSink;
}): AnalyzeDeps {
  return {
    preprocessor: new Preprocessor(),
    extractor: new GeminiExtractor(opts.model),
    normaVerifier: new GeminiNormaVerifier(
      opts.normaCache,
      opts.model,
      opts.onGroundingCusto
    ),
    riskAnalyst: new GeminiRiskAnalyst(opts.model),
    drafter: new GeminiDrafter(opts.model),
  };
}
