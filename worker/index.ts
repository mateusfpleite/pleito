/**
 * Worker container entrypoint (SPEC §3/§4/§14).
 *
 * Assembles the REAL deps (Prisma + Gemini adapters via `infrastructure/
 * factories.ts`), builds the minimal HTTP server (scale-to-zero, woken by
 * a `POST` from `/api/job`) and listens on the container port (`PORT`,
 * default 8080). On receiving the trigger, it drains the entire queue via
 * the atomic `FOR UPDATE SKIP LOCKED` claim.
 *
 * DEPLOY RESIDUE (no Postgres/credentials in this environment —
 * consistent with Phase 11, adapters/repo/client.ts): `criarPrismaClient()`
 * throws until `@prisma/adapter-pg`+`pg` are installed, `DATABASE_URL`
 * (direct, on the worker) is set and the migration is applied. The wiring
 * and the loop are 100% tested (worker/processar.test.ts, server.test.ts);
 * only the real Postgres (where SKIP LOCKED actually locks rows) +
 * WORKER_URL are missing.
 */
import { getConfig } from '../infrastructure/config.ts';
import {
  montarRepos,
  montarAnalyzeDeps,
} from '../infrastructure/factories.ts';
import { criarPrismaClient } from '../adapters/repo/client.ts';
import { analyzeEdital } from '../application/analyze-edital.ts';
import type { ArquivoEntrada } from '../domain/ports.ts';
import { criarServidor } from './server.ts';

function main(): void {
  getConfig(); // fail fast if env is missing (GOOGLE_..., DATABASE_URL, etc.)

  const prisma = criarPrismaClient();
  const repos = montarRepos(prisma);

  // Grounding cost sink (§11b) attributed PER `analyze` call.
  // `montarAnalyzeDeps` receives a STABLE sink that delegates to the
  // collector of the current call (`atual`): each `analyze(input, onCusto)`
  // points `atual` to that job's onCusto before running and clears it
  // afterwards. The worker drains 1 job at a time (sequential loop), so
  // there is no race between collectors.
  let atual: ((u: {
    lei: string;
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    totalTokens: number | undefined;
  }) => void) | null = null;
  const analyzeDeps = montarAnalyzeDeps({
    normaCache: repos.normaCache,
    onGroundingCusto: (u) => atual?.(u),
  });

  const server = criarServidor({
    jobRepo: repos.jobRepo,
    analysisRepo: repos.analysisRepo,
    telemetry: repos.telemetry,
    analyze: async (
      input: ArquivoEntrada,
      onGroundingCusto?: (u: {
        lei: string;
        inputTokens: number | undefined;
        outputTokens: number | undefined;
        totalTokens: number | undefined;
      }) => void
    ) => {
      atual = onGroundingCusto ?? null;
      try {
        return await analyzeEdital(input, analyzeDeps);
      } finally {
        atual = null;
      }
    },
  });

  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, () => {
    console.log(`[worker] HTTP up :${port} (trigger=POST, /healthz)`);
  });
}

main();
