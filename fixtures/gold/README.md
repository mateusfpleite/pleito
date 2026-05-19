# fixtures/gold — versioned regression corpus

**Frozen** POC extractions, used as a reproducible regression corpus.
Unlike `output/` (gitignored, recreated on each run), this directory is
**versioned**: it ensures the spike-matcher, the Tier 0 gate and the E2E
tests run against a stable, auditable input.

## Provenance

- **Origin:** extractions generated in the POC by the pipeline with
  **Gemini 2.5 Flash** (`src/extract.ts`), from the real editais in
  `fixtures/`.
- **Schema:** `domain/schema.ts` (schema v3 — SPEC §6).
- **Frozen at:** Phase 4 / Task 4.1 of the plan
  `docs/plans/2026-05-15-pleito-v0.md`, copied from `output/` 1:1.

## Files

| File                   | Content                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `dombasilio.json`      | Full extraction (schema v3) — divergent-value case.            |
| `jaborandi.json`       | Full extraction (schema v3) — lying-cover case.                |
| `niteroi.json`         | Full extraction (schema v3) — confidential-value case.         |
| `baserate-result.json` | Base rate: **24 editais, 13 UFs**; `allLaws` preserves the     |
|                        | revogada-law cases that underpin the spike-matcher (0/37       |
|                        | false-negative). Without it the spike is not reproducible post-P4. |
| `synthetic-verificado.json` | **SYNTHETIC self-test fixture** (not POC). 1 law       |
|                        | 8666/1993 with `statusVerificado:"vigente"` — DIVERGENT from   |
|                        | the curated baseline (`revogada-notoria` → expected `revogada`). |
|                        | It exists to EXERCISE check 3 (`baseline-divergente`) of       |
|                        | Tier 0, inert across the rest of the corpus (all `nao-verificado`). The |
|                        | runner handles it in self-test mode: it MUST produce the       |
|                        | expected violation, otherwise the check is broken → gate fails. |

## Consumers

- `src/spike-matcher.ts` — reads from here (it used to read from
  `output/`); validates blocker #1 (Gate A false-negative) against the
  real corpus, reproducibly.
- **Tier 0 Gate** (`eval/tier0.ts`, Phase 9) and **E2E**
  (`tests/e2e/corpus.test.ts`, Phase 17) — regression corpus.
- `promoverParaCorpus(id)` (Phase 15) writes new curated analyses here.

## Promoted files (Phase 15, §11b)

`promovido-<municipio>-<uf>.json` — written by
`promoverParaCorpus(analysisId)` (a button in `/admin` or
`POST /api/admin/promover/:id`). Same shape as the gold extractions (the
`EditalExtraction` at the root) + a `_proveniencia` block (the `_*` key is
stripped by the schema → does not break the Tier 0 runner's `safeParse`).
They enter the Tier 0 / E2E gate automatically on the next run:
promote-to-corpus in 1 step closes the telemetry → regression-fixture loop.

## Rule

Do not hand-edit the POC provenance files (`dombasilio`,
`jaborandi`, `niteroi`, `baserate-result`). Changes to them only via
curated telemetry promotion (Phase 15) or an explicit re-freeze of the
POC, always with a dedicated commit documenting the provenance change.

`synthetic-verificado.json` is a declared EXCEPTION: a synthetic self-test
fixture (non-POC), introduced in the real structural-containment commit
of the Drafter (recurring C1) to make Tier 0's check 3
effectively exercised. Editable only with a dedicated commit.
