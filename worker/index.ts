/**
 * Entrypoint do worker container (SPEC §3/§4/§14).
 *
 * Monta as deps REAIS (Prisma + adapters Gemini via `infrastructure/
 * factories.ts`), constrói o servidor HTTP mínimo (escala-to-zero acordado
 * por `POST` do `/api/job`) e escuta na porta do container (`PORT`,
 * default 8080). Ao receber o trigger, drena a fila inteira via claim
 * atômico `FOR UPDATE SKIP LOCKED`.
 *
 * RESÍDUO de deploy (sem Postgres/credenciais neste ambiente —
 * consistente com Phase 11, adapters/repo/client.ts): `criarPrismaClient()`
 * lança até `@prisma/adapter-pg`+`pg` instalados, `DATABASE_URL` (direta,
 * no worker) definido e migração aplicada. A composição e o laço estão
 * 100% testados (worker/processar.test.ts, server.test.ts); só falta o
 * Postgres real (onde o SKIP LOCKED de fato trava linhas) + WORKER_URL.
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
  getConfig(); // falha cedo se faltar env (GOOGLE_..., DATABASE_URL, etc.)

  const prisma = criarPrismaClient();
  const repos = montarRepos(prisma);

  // Sink de custo de grounding (§11b) atribuído POR chamada de
  // `analyze`. `montarAnalyzeDeps` recebe um sink ESTÁVEL que delega ao
  // coletor da chamada corrente (`atual`): cada `analyze(input, onCusto)`
  // aponta `atual` p/ o onCusto daquele job antes de rodar e o limpa
  // depois. O worker drena 1 job por vez (laço sequencial), logo não há
  // corrida entre coletores.
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
