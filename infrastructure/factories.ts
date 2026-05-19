/**
 * Infrastructure composition (hexagonal) — the single place that assembles
 * the CONCRETE ADAPTERS and injects them into `application/`. The domain and
 * the application never know about Gemini/Prisma; the boundary is closed here.
 *
 * - `montarRepos(prisma)`: the 4 Prisma repos over a `PrismaClientLike`
 *   (production: `criarPrismaClient()`; tests: structural fake).
 * - `montarAnalyzeDeps({ model?, normaCache })`: the workflow's
 *   `AnalyzeDeps` with the real Gemini adapters (extractor/verifier/risk/drafter)
 *   + Preprocessor. `model` is injectable (tests pass a fake — does not resolve
 *   the API key); in production each adapter resolves `google(config.MODEL)`
 *   lazily if none is passed.
 *
 * The worker (Phase 12) calls `criarPrismaClient()` → `montarRepos` →
 * `montarAnalyzeDeps` and runs `analyzeEdital`.
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

/** Prisma repos assembled over a single client (persistence boundary). */
export type Repos = {
  jobRepo: JobRepo;
  analysisRepo: AnalysisRepo;
  normaCache: NormaCache;
  telemetry: TelemetryPort;
};

/** Assembles the 4 Prisma repos over the injected client (default: production). */
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
 * Assembles the `AnalyzeDeps` with the real Gemini adapters + Preprocessor.
 * `model` is optional (injectable for tests). `normaCache` is required — the
 * Verifier needs the real cache (comes from `montarRepos`).
 */
export function montarAnalyzeDeps(opts: {
  model?: LanguageModel;
  normaCache: NormaCache;
  /**
   * OPTIONAL sink for grounding cost PER call (SPEC §11b). The worker
   * injects a per-job collector (accumulates and writes telemetry after the
   * save, with the real analysisId); absent = no-op (no instrumentation
   * outside the worker).
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
