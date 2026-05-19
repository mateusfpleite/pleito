/**
 * Prisma 7 configuration (replaces `url`/`directUrl` in schema.prisma, which
 * Prisma 7 removed from the `datasource` block).
 *
 * Serverless-safe (SPEC §14):
 *   - DATABASE_URL → pooled (Supabase pgBouncer,
 *     `?pgbouncer=true&connection_limit=1`), used by the Vercel routes.
 *   - DIRECT_URL   → direct connection for `prisma migrate` (pgBouncer does
 *     not support transactional DDL).
 *
 * `defineConfig` loads at CLI startup even for commands that do NOT connect
 * to the database (`prisma generate`). Since the POC environment has no
 * Postgres (`DATABASE_URL`/`DIRECT_URL` absent — deploy RESIDUE), we use an
 * inert placeholder that keeps offline codegen working. Real migration
 * commands (`prisma migrate deploy`) FAIL early and explicitly if the real
 * URLs are not present — the placeholder connects nowhere (nonexistent
 * host).
 */
import { defineConfig } from 'prisma/config';

// Deploy RESIDUE: set DATABASE_URL (pooled) and DIRECT_URL (direct) in the
// Vercel/worker environment. Without them, only `prisma generate` works;
// `prisma migrate` must fail — the placeholder guarantees that.
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
