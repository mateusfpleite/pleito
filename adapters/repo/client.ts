/**
 * BOUNDARY HEXAGONAL — único módulo (junto aos repos irmãos) que importa
 * `@prisma/client` / o client gerado. `domain/` e `application/` jamais
 * importam Prisma; só os ports de `domain/ports.ts`.
 *
 * Prisma 7 removeu a query-engine binária default: o `PrismaClient` exige
 * um *driver adapter* em runtime (`@prisma/adapter-pg` + `pg`). Esses
 * pacotes NÃO estão instalados neste ambiente de POC (sem Postgres real,
 * sem `DATABASE_URL`) — ver RESÍDUO abaixo. Por isso:
 *
 *   - `PrismaClientLike` (estrutural) é o que os repos consomem e o que os
 *     testes mockam — mapeamento domínio↔persistência testado de forma
 *     determinística, sem acoplar a infra externa (testing-anti-patterns).
 *   - `criarPrismaClient()` é a fábrica de produção; falha cedo e
 *     explicitamente enquanto o adapter não estiver instalado/configurado.
 *
 * RESÍDUO DE BANCO (preciso, para o deploy — Phase 17.2):
 *   1. Env vars: `DATABASE_URL` (Supabase pooled, pgBouncer:
 *      `?pgbouncer=true&connection_limit=1`) e `DIRECT_URL` (conexão
 *      direta) — ausentes neste ambiente.
 *   2. Dependências: `pnpm add @prisma/adapter-pg pg` (+ `@types/pg`).
 *   3. Migração: `prisma migrate deploy` usando `DIRECT_URL` (NÃO rodado
 *      aqui — não há Postgres; pgBouncer não aceita DDL transacional).
 *   4. `prisma generate` roda no `postinstall` (offline, já validado).
 *   Trocar o corpo de `criarPrismaClient()` por:
 *     import { PrismaClient } from '../../prisma/generated/client.ts';
 *     import { PrismaPg } from '@prisma/adapter-pg';
 *     return new PrismaClient({
 *       adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
 *     });
 */
import type { PrismaClient } from '../../prisma/generated/client.ts';

/**
 * Subconjunto estrutural do `PrismaClient` que os repos usam. Mantém o
 * boundary tipado (deriva do client gerado) sem exigir uma instância real
 * — repos recebem isto por injeção; testes passam um fake determinístico.
 */
export type PrismaClientLike = Pick<
  PrismaClient,
  // `$queryRaw` é necessário para o claim atômico `FOR UPDATE SKIP LOCKED`
  // (Phase 12) — Prisma não expõe SKIP LOCKED via API tipada, só SQL cru.
  'job' | 'analysis' | 'normaCache' | 'telemetria' | '$queryRaw'
>;

/**
 * Fábrica de produção do PrismaClient. NÃO operável neste ambiente: o
 * driver adapter (`@prisma/adapter-pg`) não está instalado e não há
 * Postgres. Lança erro acionável apontando o RESÍDUO. A factory de Phase
 * 12 injeta o client real (já com adapter) nos repos; até lá, os repos
 * são exercitados via mock (ver *.test.ts).
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
