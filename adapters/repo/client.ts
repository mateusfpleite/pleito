/**
 * HEXAGONAL BOUNDARY — the only module (alongside the sibling repos) that
 * imports `@prisma/client` / the generated client. `domain/` and
 * `application/` never import Prisma; only the ports from
 * `domain/ports.ts`.
 *
 * Prisma 7 removed the default binary query-engine: `PrismaClient`
 * requires a *driver adapter* at runtime (`@prisma/adapter-pg` + `pg`).
 * Those packages are NOT installed in this POC environment (no real
 * Postgres, no `DATABASE_URL`) — see RESIDUE below. Hence:
 *
 *   - `PrismaClientLike` (structural) is what the repos consume and what
 *     tests mock — domain↔persistence mapping tested deterministically,
 *     without coupling to external infra (testing-anti-patterns).
 *   - `criarPrismaClient()` is the production factory; it fails early and
 *     explicitly while the adapter is not installed/configured.
 *
 * DATABASE RESIDUE (precise, for deploy — Phase 17.2):
 *   1. Env vars: `DATABASE_URL` (Supabase pooled, pgBouncer:
 *      `?pgbouncer=true&connection_limit=1`) and `DIRECT_URL` (direct
 *      connection) — absent in this environment.
 *   2. Dependencies: `pnpm add @prisma/adapter-pg pg` (+ `@types/pg`).
 *   3. Migration: `prisma migrate deploy` using `DIRECT_URL` (NOT run
 *      here — there is no Postgres; pgBouncer rejects transactional DDL).
 *   4. `prisma generate` runs on `postinstall` (offline, already
 *      validated).
 *   Replace the body of `criarPrismaClient()` with:
 *     import { PrismaClient } from '../../prisma/generated/client.ts';
 *     import { PrismaPg } from '@prisma/adapter-pg';
 *     return new PrismaClient({
 *       adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
 *     });
 */
import type { PrismaClient } from '../../prisma/generated/client.ts';

/**
 * Structural subset of `PrismaClient` that the repos use. Keeps the
 * boundary typed (derives from the generated client) without requiring a
 * real instance — repos receive this by injection; tests pass a
 * deterministic fake.
 */
export type PrismaClientLike = Pick<
  PrismaClient,
  // `$queryRaw` is required for the atomic `FOR UPDATE SKIP LOCKED` claim
  // (Phase 12) — Prisma does not expose SKIP LOCKED via the typed API,
  // only raw SQL.
  'job' | 'analysis' | 'normaCache' | 'telemetria' | '$queryRaw'
>;

/**
 * Production factory for PrismaClient. NOT operable in this environment:
 * the driver adapter (`@prisma/adapter-pg`) is not installed and there is
 * no Postgres. Throws an actionable error pointing at the RESIDUE. The
 * Phase 12 factory injects the real client (already with adapter) into
 * the repos; until then, the repos are exercised via mock (see
 * *.test.ts).
 */
export function criarPrismaClient(): PrismaClientLike {
  throw new Error(
    'PrismaClient indisponível: RESÍDUO de banco. Instale ' +
      '`@prisma/adapter-pg pg`, defina DATABASE_URL (pooled) e DIRECT_URL, ' +
      'rode `prisma migrate deploy` e substitua o corpo de ' +
      'criarPrismaClient() pelo construtor com PrismaPg ' +
      '(ver adapters/repo/client.ts).'
  );
}
