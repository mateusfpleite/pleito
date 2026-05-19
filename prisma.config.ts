/**
 * Configuração Prisma 7 (substitui `url`/`directUrl` no schema.prisma, que
 * o Prisma 7 removeu do bloco `datasource`).
 *
 * Serverless-safe (SPEC §14):
 *   - DATABASE_URL → pooled (Supabase pgBouncer,
 *     `?pgbouncer=true&connection_limit=1`), usado pelas rotas Vercel.
 *   - DIRECT_URL   → conexão direta para `prisma migrate` (pgBouncer não
 *     suporta DDL transacional).
 *
 * `defineConfig` carrega na inicialização da CLI mesmo em comandos que NÃO
 * conectam ao banco (`prisma generate`). Como o ambiente do POC não tem
 * Postgres (`DATABASE_URL`/`DIRECT_URL` ausentes — RESÍDUO de deploy),
 * usamos um placeholder inerte que mantém o codegen offline funcionando.
 * Comandos reais de migração (`prisma migrate deploy`) FALHAM cedo e
 * explicitamente se as URLs reais não estiverem presentes — o placeholder
 * não conecta a lugar nenhum (host inexistente).
 */
import { defineConfig } from 'prisma/config';

// RESÍDUO de deploy: definir DATABASE_URL (pooled) e DIRECT_URL (direta)
// no ambiente Vercel/worker. Sem elas, só `prisma generate` funciona;
// `prisma migrate` deve falhar — o placeholder garante isso.
const PLACEHOLDER =
  'postgresql://placeholder:placeholder@residuo-de-deploy.invalid:5432/placeholder';

const databaseUrl = process.env.DATABASE_URL ?? PLACEHOLDER;
const directUrl = process.env.DIRECT_URL ?? PLACEHOLDER;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: databaseUrl,
    shadowDatabaseUrl: directUrl,
  },
  migrations: {
    shadowDatabaseUrl: directUrl,
  },
});
