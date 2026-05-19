# Pleito V0 — Deploy Runbook

> A **single, actionable** runbook consolidating ALL the deploy residuals
> accumulated across Phases 0–17. Code state: **273 tests green,
> typecheck clean, `pnpm build` OK, `pnpm eval:tier0` = 0 violations**. What
> remains is EXCLUSIVELY external infra (real Postgres, Vercel, the worker
> container, the production Gemini key) — no pending code bug. SPEC §14
> points here; do not duplicate content there.

Architecture (SPEC §3): **Vercel/Next.js** (UI, auth, upload→job, polling,
export) ↔ **Supabase Postgres** (jobs/analyses/norma_cache/telemetry) ↔
**worker container** scale-to-zero (7-component pipeline, poppler +
chromium).

---

## 1. Database — Supabase Postgres

1. Create a project on Supabase. Note the Postgres password.
2. Two URLs (Supabase exposes them under *Project Settings → Database*):
   - **`DATABASE_URL`** = the **pooled** connection string (pgBouncer, port
     6543), with **`?pgbouncer=true&connection_limit=1`**. Used by the
     Vercel routes (serverless-safe).
   - **`DIRECT_URL`** = the **direct** connection string (port 5432, no
     pgBouncer). Used by `prisma db push` / `migrate deploy` (pgBouncer
     does not accept transactional DDL) and by the worker.
3. Install the driver adapter (Prisma 7 removed the default query-engine
   binary — `PrismaClient` requires a driver adapter at runtime):
   ```
   pnpm add @prisma/adapter-pg pg
   pnpm add -D @types/pg
   ```
4. **Swap the body of `criarPrismaClient()`** in
   `adapters/repo/client.ts`. The EXACT snippet is already commented in the
   header of that file (DATABASE RESIDUAL, item "Swap the body…"):
   ```ts
   import { PrismaClient } from '../../prisma/generated/client.ts';
   import { PrismaPg } from '@prisma/adapter-pg';
   return new PrismaClient({
     adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
   });
   ```
   Today the function throws an actionable error (`RESÍDUO de banco…`) — it
   is the only code point that changes at deploy.
5. **Apply the schema.** There is NO `prisma/migrations/` folder — the
   project uses **`prisma db push`** (schema-first, no migration history).
   Run it against the **`DIRECT_URL`**:
   ```
   DIRECT_URL=<direct> DATABASE_URL=<direct> pnpm prisma db push
   ```
   (or `prisma migrate deploy` if/when migrations are introduced —
   V1). **ALL the columns of the current schema must go**, across 4 models
   (`prisma/schema.prisma`): `Job`, `Analysis` (incl.
   **`oficioExportado`** + **`oficioExportadoEm`**), `NormaCache`,
   `Telemetria`. `prisma generate` already runs in `postinstall` (offline,
   already validated in this environment).
6. **`prisma.config.ts` — TRAP (Phase 11 review Minor #1):** today the
   file sets `shadowDatabaseUrl: directUrl` (and
   `datasource.shadowDatabaseUrl: directUrl`). This is **harmless for
   `db push`/`migrate deploy`** (they do not use a shadow DB), but
   **catastrophic if anyone runs `prisma migrate dev`**: `migrate dev`
   **RESETS** the database pointed to by `shadowDatabaseUrl`. Pointing the
   shadow at the production `DIRECT_URL` = **reset of the production DB**.
   Before deploy, in `prisma.config.ts`: **OMIT `shadowDatabaseUrl`**
   (deploy only uses `db push`/`migrate deploy`, which do not need it) OR
   point it at a **distinct throwaway database** (never production). Never
   run `migrate dev` with the current config against production.

---

## 2. Vercel — Next.js

Deploy the repo (App Router). Routes that touch Prisma are already set with
`runtime='nodejs'` (done — no action).

**Env vars (exact) in the Vercel project:**

| Var | Value | Notes |
|---|---|---|
| `GOOGLE_GENERATIVE_AI_API_KEY` | **production** Gemini key | In DEV the employer's is used; **review/rotate for production** (real calls cost). |
| `DATABASE_URL` | **pooled** URL (`?pgbouncer=true&connection_limit=1`) | Serverless routes. |
| `DIRECT_URL` | **direct** URL | Required by `config.ts` (Zod `.min(1)`); used by migrations. |
| `APP_SECRET` | session secret (HMAC) | Single-user auth (SPEC §14 #7). **Pass to Stefany out-of-band** (direct message), never in the repo. |
| `WORKER_URL` | **public** URL of the worker (see §3) | Vercel does a `POST` here when creating the job (scale-to-zero wake-up). |
| `EXTRACTOR_MODEL` | optional | Default `gemini-2.5-flash`. |

**Body size limit (deploy concern):** Vercel's **Hobby** plan cuts the
request body at **~4.5 MB at the edge**, BEFORE the code (an opaque 413).
The `/api/job` upstream guard is **`MAX_UPLOAD_BYTES = 8 MiB`**
(`app/api/job/handler.ts`) — larger than the Hobby cut. Consequence:
editais between ~4.5 and 8 MiB receive a **413 from the edge** (not the
guard's clear 413) on Hobby. **Mitigation:** use the **Pro** plan (larger
body) OR accept the edge 413 for that range. The **real corpus editais are
< ~5 MB**, so the real case is covered; uploads of 4.5–8 MiB only pass
outside Hobby. Resolving with Pro/larger body is a deploy residual (no code
change).

---

## 3. Worker container — Railway or Cloud Run (scale-to-zero)

The worker runs the 7-component pipeline outside the serverless model (no
timeout limit, with system binaries). The `Dockerfile` is ready.

1. **Image build:** the `Dockerfile` (root) already does
   `apt-get install -y poppler-utils chromium` over `node:20-slim`,
   `pnpm install --frozen-lockfile`, `CMD ["pnpm","worker"]`.
2. **Optional dependencies:** `playwright-core` is in
   `optionalDependencies` (PDF export via chromium). `pnpm install`
   installs `optionalDependencies` by **default** (do not pass
   `--no-optional`). The Dockerfile's `--frozen-lockfile` keeps this.
3. **chromium path:** `adapters/pdf/render.ts` uses `/usr/bin/chromium`
   (Debian package on `node:20-slim`), **overridable via
   `CHROMIUM_PATH`**. On Railway/Cloud Run with the Dockerfile image the
   default already resolves.
4. **Worker env vars:**
   | Var | Value |
   |---|---|
   | `DATABASE_URL` | the **DIRECT** connection (NOT pooled — the worker opens its own pool; pgBouncer interferes with `FOR UPDATE SKIP LOCKED` and a nested pool). Use the `DIRECT_URL`. |
   | `GOOGLE_GENERATIVE_AI_API_KEY` | same production key. |
   | `EXTRACTOR_MODEL` | optional (default `gemini-2.5-flash`). |
   | `PORT` | the container's exposed port (the worker reads `process.env.PORT ?? 8080`, `worker/index.ts`). |
   | `CHROMIUM_PATH` | optional (default `/usr/bin/chromium`). |
5. **Publish the service's public URL** (Railway/Cloud Run give a public
   domain) and **set `WORKER_URL` on Vercel** with that URL. Vercel does
   NOT reach the container's private network — the URL must be public.
6. **Vercel → worker connectivity:** `POST /api/job` (Vercel) creates the
   `pending` Job and does a **`POST` to `WORKER_URL`** — that HTTP request
   is what **wakes** the scale-to-zero container (it does not wake on a DB
   row; blind polling while asleep does not work). On receiving the POST
   the worker drains the entire queue via `drenarFila` (atomic claim
   `UPDATE … FOR UPDATE SKIP LOCKED … RETURNING *` — two workers never pick
   up the same job). `/healthz` is available for probes.

---

## 4. Liveness caveat (no sweeper) — acceptable V0

There is NO sweeper/cron for `pending` jobs. Flow: `/api/job` wakes the
worker over HTTP; if that trigger fails, the Job survives `pending` and is
**picked up at the worker's next wake** (`claimNext` drains everything).
But if the worker is **permanently down**, jobs stay `pending`
indefinitely — **there is no automatic re-trigger**. **Acceptable
single-user V0** (the operator resubmits). **Revisit in V1** with a
cron/healthcheck that re-dispatches pending ones.

---

## 5. Done V0 checklist (SPEC §12) — honest

### Green OFFLINE (validated in this environment, no infra)

- [x] **Schema 100% valid** — `domain/schema.test.ts` + E2E
  `tests/e2e/corpus.test.ts` (each gold reconstructs and parses
  `EditalExtractionSchema`).
- [x] **`pnpm eval:tier0` = 0 violations** (hard structural gate) — the
  `eval/run-tier0.ts` runner over `fixtures/gold/*` + the synthetic
  self-test `synthetic-verificado.json` (check 3 effectively exercised).
- [x] **Lying-cover / revogada-law / missing-annex detected** — as a
  deterministic invariant over the POC gold corpus: Jaborandi
  records an object-divergent `incoerencia` (high sev.) + `lei-revogada`
  and its 8666/1993 + 10520/2002 match the `revogada-notoria` baseline;
  Niterói regime `lei-13303` + annex `presenteNoArquivo=false`; Dom
  Basílio `valor-divergente` high sev. (`tests/e2e/corpus.test.ts`).
- [x] **Structural containment** — `eval/tier0.test.ts` (property-based) +
  fatal Tier 0 in `application/analyze-edital.ts` + `checarContencao`
  over each gold with `oficio:null` → 0 violations.
- [x] Pipeline/worker/gates/persistence/auth **unit + integration with
  mocks** green (273 tests; `worker/processar.test.ts`,
  `adapters/repo/repo.test.ts`, `app/api/**`, `lib/middleware-auth`,
  etc.).

### Only closes POST-DEPLOY (requires real infra — not a code bug)

- [ ] **3 ref editais + Mata Grande with no error** via the REAL worker
  (Gemini 2.5 Flash + Postgres) — extraction quality is validated in
  production via telemetry (SPEC §11c), not as a test that fails offline.
- [ ] **Full pipeline in the worker with no timeout** (Done V0: < 90 s) —
  measurable only with real Gemini + container.
- [ ] **Job trigger + atomic claim** end-to-end on real Postgres
  (logic tested with a mock; `FOR UPDATE SKIP LOCKED` requires real PG).
- [ ] **Dashboard + editable ofício + on-demand PDF** e2e (real chromium
  in the container; no chromium in DEV).
- [ ] **Telemetry recording** on real Postgres.
- [ ] **Deploy accessible to Stefany** (public Vercel URL + `APP_SECRET`
  delivered out-of-band).

> Post-deploy acceptance criterion: submit the 3 reference editais +
> Mata Grande through the UI; each job completes `done` < 90 s; `pnpm eval:tier0`
> stays 0; the dashboard renders all panels; PDF export returns a
> `%PDF` buffer; telemetry records `submissao`/`analise_concluida`.

---

## 6. PRODUCT residuals (not deploy — record for discussion)

They do not block deploy; they are product decisions/hardening to discuss:

1. **100% templated ofício** (SPEC §5 #2): total structural containment
   makes the ofício rigid (zero free LLM prose). Utility × safety
   trade-off — mitigated by the **human-in-the-loop** (Stefany
   edits the textarea before exporting). Evaluate whether the rigidity
   reduces perceived utility.
2. **Ofício header identifiers** (`razaoSocial`, the edital's `numero`)
   are **free `z.string()` from the extractor** interpolated into the
   ofício header. Low risk (they are not legal status; there is no
   non-LLM source for these fields), but they are the only LLM-origin
   string in the document. Record as a conscious exception to the
   exhaustive invariant.
3. **Name collision in `promovido-*.json`** (Phase 15): the
   `promoverParaCorpus` writes `promovido-<municipio>-<uf>.json`; two
   promotions of the same municipality/UF **silently overwrite** the
   previous one. V1 hardening (unique suffix / collision detection).
4. **Dashboard polling — non-404 HTTP errors:** the polling client
   handles 404 but non-404 error responses fall into `r.json()` and may
   silently break the parse. V1 hardening (explicit handling of
   5xx/timeout in polling).

---

## 7. Minimal deploy sequence (actionable summary)

1. Supabase: create the project → obtain `DATABASE_URL` (pooled) + `DIRECT_URL`.
2. `pnpm add @prisma/adapter-pg pg && pnpm add -D @types/pg`.
3. Edit `adapters/repo/client.ts` (snippet commented in the header).
4. Adjust `prisma.config.ts`: **remove `shadowDatabaseUrl`** (or point it
   at a throwaway DB). NEVER `migrate dev` against production.
5. `prisma db push` via `DIRECT_URL` (creates all 4 models in full).
6. Vercel: deploy + the §2 env vars (`APP_SECRET` out-of-band).
7. Worker: build the Dockerfile → Railway/Cloud Run scale-to-zero; §3
   env (`DATABASE_URL` = DIRECT, `PORT`).
8. Publish the worker's public URL → set `WORKER_URL` on Vercel.
9. Acceptance: submit 3 refs + Mata Grande through the UI; verify `done` < 90 s,
   `pnpm eval:tier0` = 0, panels + PDF export + telemetry.
10. Deliver the URL + `APP_SECRET` to Stefany.
