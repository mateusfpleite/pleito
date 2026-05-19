# Pleito — Specification

> **Living** document. Current authoritative state. The "why" and the evidence trail are in `PROVENANCE.md`. A non-technical pitch is maintained separately, outside this repository.

**Updated:** 2026-05-15 (rev. post plan-review: async/worker architecture + observability)

---

## 1. Vision & thesis

Vertical AI for analyzing Brazilian municipal B2G procurement (licitações), with the funeral sector as the wedge. Anchor customer: Zelo. The LLM is a commodity substrate; the value comes from the **structured accumulation of the composite regulatory stack** per municipality/sector + integration into the customer's workflow. Moat = curated data with provenance (`data/norma-baseline.json`), starting at V0.

## 2. Target user

V0–V1 Stefany (sole analyst) · V2+ Zelo team · V3+ other municipal B2G companies · V4+ other verticals.

## 3. Architecture

**Execution split (decision post plan-review):**

- **Vercel / Next.js** — only what is fast and request-scoped: UI/dashboard, auth, upload (creates job), status polling, on-demand PDF export.
- **Worker container** (Railway or Cloud Run, scale-to-zero, Dockerfile with `poppler-utils` + chromium) — runs the 7-component pipeline. **Outside the serverless model**: no timeout limit, with system binaries. Reuses ALL the validated TS code.
- **Supabase Postgres** — `jobs`, `analyses`, `norma_cache`, telemetry.

Principles: hexagonal at the LLM boundary (ports swappable by env var) · YAGNI (no Mastra until V2) · schema evolved against real editais · defense in depth in the Verifier's security · persist content that is never derived.

**Reuse (corrected post plan-review):** what is reused is **validated prompts, `data/norma-baseline.json` and the schema**; the I/O of the CLI scripts (`src/extract.ts`, `src/spike-verifier.ts`) is **rewritten** as adapters (they were `main()`+`process.exit`, not modules). "Reuse everything" was imprecise.

**Folder structure:**

```
pleito/
├── app/                  # Next.js (Vercel): upload, dashboard, /api/{job,status,export}
├── worker/               # worker container entrypoint (job loop)
├── domain/               # types, Zod schema, ports, baseline matcher (zero dep)
├── application/          # analyzeEdital workflow (orchestrates + 2 gates)
├── adapters/             # extractor, verifier, risk-analyst, drafter, pdf, repo, telemetry
├── data/norma-baseline.json
├── infrastructure/       # config, factories, env
├── eval/                 # deterministic Tier 0 gate (property-based)
├── fixtures/             # validation corpus
└── docs/
```

## 4. Pipeline (async, in the worker)

```
Vercel: upload → creates job(status=pending) → returns jobId   │  dashboard polls /api/status/:id
                          │                                  ▲
                          ▼ worker picks up job (status=running)  │ status/result
  1. Preprocessor [code] zip/gz/pdf → text (pdftotext -layout, runs in the container)
  2. Extractor   [Gemini Flash, no tool] schema v3; PROVISIONAL revogada flags
  3. gate A: baseline matcher over ALL leis (deterministic, zero cost) →
       triggers verification if matcher ∈ {revogada-*, zona-cinzenta, citacao-suspeita}
       OR extractor flagged revogada=true   [closes false-negative]
  4. Norma Verifier [conditional] baseline (precedence) → web grounding (tail) → cache
  5. Risk Analyst  pontosDeAtencao{severidade,categoria}, consumes VERIFIED status
  6. gate B: incoherence sev≥medium OR ambiguous excerpt OR recomendaManifestacao
  7. Drafter [conditional] clarification/challenge; only asserts revogação if
       statusVerificado=revogada; otherwise → asks the issuing body
  → writes analyses + telemetry; job status=done
```

Models: Gemini 2.5 Flash (fallback Haiku 4.5 tool / Sonnet 4.6 schema), via env per adapter.

## 5. Verifier security (3 layers, defense in depth)

Risk: the Extractor's `revogada` flag is a guess (~57% accuracy, false-positive bias). If it leaks into the external ofício → irreversible damage to Zelo's credibility.

1. **Curated baseline** (`data/norma-baseline.json`) — categories: `revogada-notoria`, `revogada-confirmada`, `vigente-ancora` (anti-false-positive), `zona-cinzenta` (never binary), `citacao-suspeita`. Hit = deterministic, zero cost.
2. **Web grounding** (Gemini + Google Search) — only the tail outside the baseline.
3. **Containment in the Drafter** — infralegal status is never asserted as bare fact in the external ofício; zona-cinzenta/unverified → asks; mandatory human review before export.

**Gate A closes the false-negative:** the baseline matcher runs over ALL `leisReferenciadas` (local lookup, no LLM, free), not just the ones the extractor flagged. A known revogada law is caught even if the extractor said `revogada=false`. There is no "uncertain" signal in the schema — removed; the trigger is matcher-classifies-risk OR extractor-flag.

**Matcher design (empirically validated — spike `src/spike-matcher.ts` against 99 real laws from `output/*.json`):** match on **primary number+year**; `escopo`/`tipoNorma` are **soft** signals (tolerant fallback that ignores both), because the extractor gets escopo/tipo wrong in ~54% of citations. `normalizarNumero` is applied to **both sides** (the extractor produces `"14133"`, the baseline has `"14.133"`). Result: false-negative **0/37** with normalization+fallback vs **23/37 (62%)** with strict non-normalized matching (the bug the plan masked). Strict matching alone would catch only 46%. **Residual risk recorded:** a number+year collision between distinct federal and state laws did not occur in the corpus — not refuted; mitigation: the fallback prefers escopo when present, `citacao-suspeita` entries flag rather than silence.

**#2 — REAL structural containment (ZERO free model prose in the external ofício):** the Drafter's model **writes NO text that enters the document**. It emits ONLY structured decisions: `tipo`; `selecoes[]` — references by `{fonte∈{incoerencia,trechoAmbiguo,pontoDeAtencao}, indice}` to findings **ALREADY EXISTING** in the extraction (the model chooses WHAT to raise and the ORDER, it does **NOT WRITE**); and `leisCitadas[]` with **`afirmacaoVigencia ∈ {nenhuma, revogada, vigente}`** (still overridden by the lookup). **There is NO free-text field in the model's schema** (`pontos[].{titulo,argumento}` removed); the Zod `.strip()` discards any extra field the model invents — it never reaches the adapter. The **body of the ofício is assembled 100% by deterministic TEMPLATES in the adapter** (`adapters/drafter/gemini.ts`), keyed by the **STRUCTURED TYPE** of the finding: incoherence → template by `incoerencia.tipo` (enum; `lei-revogada` routes through the vigência logic); trechoAmbiguo → template with reference by **non-LLM INDEX** ("item nº N of the analysis"); pontoDeAtencao → template by `categoria` (enum). **EXHAUSTIVE INVARIANT (C1 3rd — not whack-a-mole by channel):** every character of `oficio.markdown` is **(a)** a fixed template literal, **(b)** a restricted enum value (`incoerencia.tipo`, `pontoDeAtencao.categoria`, the ofício's `tipo`), **(c)** a **non-LLM** scalar (index, count, curated host of a baseline URL), or **(d)** a deterministic vigência template phrase. **NO free-text LLM string** — neither from the Drafter's model, nor from ANY free `z.string()` field produced upstream by the extractor (`trechosAmbiguos[].secaoOndeAparece`, `incoerencia.descricao`, `porQueAmbiguo`, `pontoDeAtencao.descricao`) or by the verifier (grounding `fonteVerificacao` — `VerdictSchema.fonte` is an LLM `z.string()`) — is interpolated, **anywhere**. `secaoOndeAparece` (a free `z.string()` field from the extractor) is **NO LONGER** a slot: it leaked verbatim, guarded only by the tripwire that this SPEC forbids as a guarantee. A revogação assertion = a **template phrase keyed by the verified `statusVerificado`**, only for a law with a UNIQUE match + `statusVerificado=revogada`; anything else → a neutral question template. The **provenance** of the revogação is a **FIXED** phrase ("per the vigência verification recorded in the analysis"); the `fonteVerificacao` is only cited — and even then **only the HOST** (domain, non-LLM scalar, allowlist of official domains), never the text — when the source is provably the **curated baseline** (`matchNorma` → revogada-* category of `data/norma-baseline.json`), **never** the grounding string. That is why "ab-rogada"/"não subsiste"/"eficácia exaurida"/"tacitamente afastada"/etc. are **structurally impossible** to appear — **there is no channel through which free LLM text (model OR extraction/verification) can write into the document**; they are not "filtered". Robust lookup: `numero/ano=null` or a non-unique `numero|ano` key → non-identifiable → always `nenhuma`/neutral. **The lexical scan (in the adapter and in Tier 0) is a DEFENSIVE TRIPWIRE, NOT the containment mechanism:** the guarantee is the absence of free prose; if the tripwire fires (markdown matches the lexicon without a verified revogada law) it is a **structural bug** (a template introduced status prose) → hard fail. The expanded regex (`ab-rogad|derrogad|revogou-se|não subsiste|superad|exaurid|deixou de produzir efeitos|não vige|sem eficácia|não está em vigor|…`) is defense-in-depth, not the barrier. **Centralized `categoriaParaStatus` map** in `domain/categoria-status.ts` (single source; Verifier and Tier 0 import it — a security mapping without a divergeable copy).

`norma-baseline.json` is an accumulable asset (moat).

## 6. Extraction schema (v3)

In `domain/schema.ts` (migrate from `src/schema.ts` v2). Over v2: `plataforma`, `subcontratacaoPermitida`, `intervaloMinimoLances`, `prazoRecursosDiasUteis`, `informacoesViabilidade`, and `pontosDeAtencao[]` (`{descricao, categoria∈{financeiro,operacional,juridico,competitivo}, severidade∈{alta,media,baixa}, recomendaManifestacao}`). `leisReferenciadas[]` gains `statusVerificado∈{vigente,revogada,contestada,inexistente,nao-verificado}` (default `nao-verificado`) + `fonteVerificacao`. **There is no "uncertain" field in the extractor output** (it was a phantom premise).

## 7. Prompt conventions

System (static, cacheable): role → rules → 1-3 few-shot. User: `[large context]` → `[task]` → `[output contract]` (long-context recency). Few-shot examples **do not exist in the POC — they must be created** from the real gold artifacts (3 trap editais; Mata Grande analysis; Pariconha ofício; baseline per category), versioned as assets.

## 8. UI

Single-edital dashboard: sectioned panels; pontos de atenção/inconsistencies/ambiguous excerpts highlighted by severity; table of laws with a `statusVerificado` badge (✓/✗/⚠); ofício as an editable textarea (human-in-the-loop). Processing state via job polling. On-demand PDF export buttons. History/search/comparison = V1.

## 9. Persistence

Persist content: the analysis JSON + the ofício **as generated** and **as exported** (the diff between the two is an eval signal — §11b). Never the PDF (a regenerable derivative). `jobs` (status/error), `norma_cache` (reusable verified status). PDF always on-demand.

## 10. Model & cost

Gemini 2.5 Flash. ~$0.09/edital (extractor ~75%). Single-user <$5/month. `pdftotext -layout` runs in the worker container (the Vercel binary problem is **dissolved** by the async architecture). Verifier ≈ free on the recurring set (deterministic baseline). Product-mode levers: trim output > caching (dev) > model swap (negligible). Do not optimize at V0.

## 11. Verification & Observability

**11a. Tier 0 gate (ships in V0, property-based, deterministic, zero cost, every change):** structural invariants, not corpus comparison, so they generalize to never-seen editais:
- For each law cited in the ofício: `afirmacaoVigencia=revogada` **only** if `statusVerificado=revogada` (a check on the Drafter's structured field, §5 #2 — not regex on prose). **Hard gate = 0 violations.** Containment is **structural** via the **exhaustive invariant** (§5 #2): the external document is assembled ONLY from literals/enums/non-LLM scalars/vigência template phrases — **no free-text LLM string** (from the Drafter's model OR from ANY free `z.string()` field of extraction/verification — `secaoOndeAparece`, `*.descricao`, `porQueAmbiguo`, grounding `fonteVerificacao`) is interpolated, anywhere. The lexical tripwire is a DEFENSIVE regression detector that should NEVER fire, **not the guarantee**. This Tier 0 is verification redundancy, not the single barrier.
- **Defensive tripwire (NOT the containment mechanism):** a broad lexical scan for revogação in the markdown — the Drafter already applies it internally; here Tier 0 re-checks it — if it fires but there is no verified revogada law backing it, it is a **structural bug** (a template introduced status prose, OR a slot went back to interpolating a free LLM string) → fail. It should never fire; the guarantee is the exhaustive invariant (zero free LLM string), not this scan. **Known limit:** the tripwire only catches revogação *lexicon*; status prose WITHOUT that lexicon ("tacitamente afastada", "já não produz efeito") would pass silently — precisely why the guarantee CANNOT be the tripwire, but rather the structural absence of any free-string slot (tested by adversarial STRUCTURAL-ABSENCE tests, not regex-absence).
- No norma from `norma-baseline.json` resolved with a status divergent from the table (the `categoriaParaStatus` map centralized in `domain/categoria-status.ts`, imported by Verifier and Tier 0). **Coverage honesty:** in the POC gold corpus this check is inert (everything is `nao-verificado`); the versioned synthetic fixture `fixtures/gold/synthetic-verificado.json` (1 law with `statusVerificado` divergent from the baseline) is handled by the runner in self-test mode — it MUST produce the `baseline-divergente` violation, otherwise the check is broken → gate fails. Thus check 3 is effectively exercised.
- zona-cinzenta never becomes binary in the ofício.
Runs in `eval/`. Failed → build fails. Does not depend on Stefany's usage — it protects against catastrophic damage from the 1st use.

**11b. Observability (V0):** implicit signals (zero friction) > explicit:
- **Generated × exported ofício diff** (gold signal: a direct, unsupervised label of the Drafter's error/gap).
- Export/which artifacts, re-upload of the same edital, opened panels, latency, cost.
- Minimal explicit: 👍/👎 + optional text per analysis; a rotating micro-question.
- **Cost per grounding call** logged individually (not just aggregated) — the real municipal tail triggers paid grounding; a silent bomb if not instrumented.
- Signal fallback: if the generated×exported ofício diff comes back empty (she accepts without editing / does not export), the gold signal is null — use export-yes/no + 👍/👎 as a reserve signal.
- Internal **review surface** (list of analyses + feedback + diffs) — without it the loop does not close.
- **Promote-to-corpus** in 1 step writes to **`fixtures/gold/` (versioned, NOT to `output/` which is gitignored)** — becomes a Tier 0/E2E regression fixture.

**11c. Accuracy/decision evals = V1**, built from the collected telemetry (not a-priori). Axis: property-first / corpus-by-failure-coverage, not corpus-centric.

## 12. Roadmap

**V0 (under construction)** — scope:

| In | Out (V1+) |
|---|---|
| Vercel UI + worker container + async jobs | History/search/comparison |
| Preprocessor (pdftotext in the container) | Full municipal profile |
| Extractor (schema v3) | Compliance vs company profile |
| Norma Verifier (baseline + grounding) | Detailed operational analysis (Tier 2) |
| Risk Analyst (pontosDeAtencao) | Bid-rigging detection (Tier 2) |
| Drafter (editable clarification/challenge) | Accuracy/decision evals |
| Dashboard + on-demand PDF export | |
| **Tier 0 Gate** + **observability/feedback** | |
| Persistence + deploy (Vercel+worker+Supabase) | |

Done V0: 3 ref editais + Mata Grande with no error; schema 100% valid; lying-cover/revogada-law/missing-annex detected; **Tier 0 Gate = 0 violations**; full pipeline in the worker with no timeout; functional dashboard; editable ofício; telemetry recording; deploy accessible to Stefany.

**V1** history/search, comparison, municipal profile, Zelo profile+compliance, accuracy evals (from telemetry), robust auth. **V2** pgvector+RAG library, NLP chat, memory (**Mastra**), PNCP monitor. **V3** parallel multi-agent, cross-municipality diff, draft proposal. **V4+** financial (municipal billing), multi-tenancy, ERP, other verticals.

## 13. Out of scope

Do not replace legal judgment · no automatic proposal V0/V1 · no ERP V0/V1/V2 · funeral only until V4 · ~200-300 Zelo municipalities · no mobile.

## 14. Deploy

> **Actionable operational runbook (step-by-step, exact env vars,
> consolidated residuals, Done V0 checklist): [`docs/DEPLOY.md`](DEPLOY.md).**
> This section records only the deploy architecture DECISIONS; the
> execution steps are not duplicated here.

- **Vercel:** Next.js (Node runtime on routes with Prisma). `DATABASE_URL` pooled (Supabase pgBouncer, `?pgbouncer=true&connection_limit=1`), `directUrl` for migrations, `prisma generate` in `postinstall`.
- **Worker:** container (Railway/Cloud Run, scale-to-zero), Dockerfile `apt-get install poppler-utils chromium`; direct Postgres connection. **#3 wake-up:** `/api/job` (Vercel) does an HTTP `POST` to the worker endpoint when creating the job — *that request wakes the container* (scale-to-zero only wakes on HTTP, not on a DB row; blind polling does not work while asleep). **#3 lock:** atomic claim `UPDATE jobs SET status='running' WHERE id=(SELECT id FROM jobs WHERE status='pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *` — two workers never pick up the same job.
- **Auth (#7, decided):** V0 single-user. `APP_SECRET` in env. `/login` = a form with a password field → `POST /api/login` validates against `APP_SECRET` → sets a signed session cookie (HMAC, httpOnly). Middleware protects everything except `/login`, `/api/login`, `/api/health`. The secret is passed to Stefany out-of-band (direct message). Supabase Auth is deferred to V1 multi-user.
- Gemini key: the employer's in dev; review for deploy.
- **Phase 12 residual (precise):** `WORKER_URL` = the **public** URL of the worker endpoint (Vercel cannot reach the container's private network). The worker container opens a **DIRECT** Postgres connection (no pgBouncer; its own pool). Vercel routes that touch Prisma are already set with `runtime='nodejs'` (done). Remaining for deploy: provision the container (Railway/Cloud Run), publish the URL, set `WORKER_URL` on Vercel, install `@prisma/adapter-pg pg` and run `prisma migrate deploy` via `DIRECT_URL` (see `adapters/repo/client.ts`).
- **Liveness without a sweeper (V0 caveat):** there is no sweeper/cron for `pending` jobs. `/api/job` wakes the worker over HTTP (#3); if that trigger fails, the job survives `pending` and is picked up at the worker's **next** wake (`claimNext`). But a worker permanently down ⇒ jobs stay `pending` indefinitely (no automatic re-trigger). Acceptable for single-user V0 (the operator resubmits); **revisit in V1** with a cron/healthcheck that re-dispatches pending ones.
- **Body size limit (deploy concern):** Vercel **Hobby** cuts the request body at **~4.5 MB** at the platform, BEFORE the code (an opaque 413 from the edge). `/api/job` applies its own UPSTREAM guard — `MAX_UPLOAD_BYTES = 8 MiB` (pre-base64), blocking with a clear **413** before packing/persisting (base64 inflates ~33% → `inputRef` ~10.7 MiB, still << the 50 MB decompression cap). Corpus editais are < ~5 MB, so the guard covers the real case; uploads of 4.5–8 MiB only pass outside Hobby (resolving with a Pro plan / larger body is a deploy residual).
