import { describe, it, expect } from 'vitest';
import {
  montarAnalyzeDeps,
  montarRepos,
} from './factories.ts';
import { Preprocessor } from '../adapters/pdf/preprocessor.ts';
import { GeminiExtractor } from '../adapters/extractor/gemini.ts';
import { GeminiNormaVerifier } from '../adapters/verifier/gemini.ts';
import { GeminiRiskAnalyst } from '../adapters/risk-analyst/gemini.ts';
import { GeminiDrafter } from '../adapters/drafter/gemini.ts';
import { PrismaJobRepo } from '../adapters/repo/job.ts';
import { PrismaAnalysisRepo } from '../adapters/repo/analysis.ts';
import { PrismaNormaCache } from '../adapters/repo/norma-cache.ts';
import { PrismaTelemetry } from '../adapters/repo/telemetry.ts';
import type { PrismaClientLike } from '../adapters/repo/client.ts';

/**
 * Testes DETERMINÍSTICOS da composição (wiring) — não tocam Gemini nem
 * Postgres (testing-anti-patterns: provar a montagem, não o engine). Um
 * `LanguageModel` fake é injetado para que os adapters Gemini não tentem
 * resolver API key/env; um `PrismaClientLike` fake substitui o banco.
 */

const fakeModel = { id: 'fake' } as never;

function fakePrisma(): PrismaClientLike {
  const stub = {
    create: async () => ({}),
    findUnique: async () => null,
    update: async () => ({}),
    upsert: async () => ({}),
  };
  return {
    job: stub,
    analysis: stub,
    normaCache: stub,
    telemetria: stub,
    $queryRaw: async () => [],
  } as unknown as PrismaClientLike;
}

describe('montarAnalyzeDeps', () => {
  it('builds AnalyzeDeps with the real adapters (pipeline types)', () => {
    const cache = new PrismaNormaCache(fakePrisma());
    const deps = montarAnalyzeDeps({ model: fakeModel, normaCache: cache });

    expect(deps.preprocessor).toBeInstanceOf(Preprocessor);
    expect(deps.extractor).toBeInstanceOf(GeminiExtractor);
    expect(deps.normaVerifier).toBeInstanceOf(GeminiNormaVerifier);
    expect(deps.riskAnalyst).toBeInstanceOf(GeminiRiskAnalyst);
    expect(deps.drafter).toBeInstanceOf(GeminiDrafter);
  });
});

describe('montarRepos', () => {
  it('builds the Prisma repos over the injected client', () => {
    const prisma = fakePrisma();
    const repos = montarRepos(prisma);

    expect(repos.jobRepo).toBeInstanceOf(PrismaJobRepo);
    expect(repos.analysisRepo).toBeInstanceOf(PrismaAnalysisRepo);
    expect(repos.normaCache).toBeInstanceOf(PrismaNormaCache);
    expect(repos.telemetry).toBeInstanceOf(PrismaTelemetry);
  });
});
