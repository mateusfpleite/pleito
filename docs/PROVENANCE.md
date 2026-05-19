# Pleito — Provenance & Decisions

> **Append-only** log of the evidence trail and decisions. The product's current state is in `SPEC.md`. Here lies *how we got there* and *based on what* — rigor material for the Amber pitch and for continuity.

**Started:** 2026-05-13 · **Last entry:** 2026-05-15

---

## 1. Origin (2026-05-13)

Objective: demonstrate agentic engineering for an application to Amber AI (agentic OS for brands with a physical supply chain; stack Next.js+Supabase+Prisma+Mastra/LangChain). Seed idea: an agentic flow over public procurement (PNCP). Pivot to real pain via Stefany (sister), structuring Zelo's procurement area (funeral services, ~all municipalities of Brazil).

## 2. Problem discovery

Method: an open question about pain, without presenting solutions. Audio clips from Stefany (canonical excerpts):

> "I don't know if there's a way to automate it (...) you have to read it. The law has many loopholes (...) each municipality has its own law (...) Zelo has a unit in almost every municipality"

> "my difficulty is the matter of the law (...) there's no way for me to memorize the law of each municipality (...) [ex-dev boss] the bigger difficulty would be a financial-aid software (...) the procurement process is not such a big volume"

**Reframe:** do not automate the reading (irreplaceable) — do the work *around* it. The boss's financial pain → V4. **Methodological principle:** a non-technical domain expert → extract the pain, never present solution options.

## 3. Reference editais

Collected: Dom Basílio/BA PE 90065/2025 (baseline, cover×TR value divergence), Jaborandi/BA PE 008/2025 (**lying cover** "water tankers", anachronistic revogada law), Niterói/RJ ION PE 90005/2025 (regime 13.303, confidential value, missing annex). Sent by Stefany: Mata Grande/AL PE 016/2026 (edital + her analysis) and a clarification ofício from Pariconha/AL (real format).

## 4. Schema evolution

v0 (hypothesis) → v1 (Dom Basílio+Jaborandi: objetoCapa/Corpo, value provenance, items, incoerencias×trechosAmbiguos, structured habilitação) → v2 (Niterói: regimeJuridico top-level, anexos.presenteNoArquivo, tipoNorma, regimeExecucao) → v3 (Mata Grande: plataforma, subcontratacao, intervaloMinimoLances, prazoRecursos, informacoesViabilidade, **pontosDeAtencao[]**).

## 5. Model selection

Benchmark (May/2026): Gemini 2.5 Flash approved (1M context, MMLU-Pro 80.9, $0.30/$2.50). Flash Lite rejected (structured-output bugs). GPT-5.4 mini ok but 2.5x more expensive. Haiku 4.5 weak for the extractor (200k), strong for tool use. DeepSeek rejected (PT-BR legal not validated). POC against the 3 editais: 100% schema valid, 71s average, $0.056/edital, caught the lying cover + revogada law + confidential + missing annex.

## 6. Validation of the heterogeneity premise

Research across 15 municipalities: a municipal funeral law exists in 14/15 (constitutional competence, art. 30 V CF + ADI 1.221/RJ); concessions do vary in practice (STF ADPF 756/2021 validated Curitiba's rotation); **sanitary requirements are more federal than Stefany supposed** (RDC ANVISA 33/2011, 662/2022, CONAMA 335/2003). Reframe: the moat is not the isolated funeral law (repetitive content) — it is the **composite regulatory stack** per municipality.

## 7. Competitive landscape

~20 Brazilian players, all horizontal, thin AI over an LLM, pricing R$ 40-2,000/month. Funeral software (Dream/PROGEM/Unymos): operational only. International (Govini/GovDash): mature, horizontal. **White space:** nobody curates the municipal regulatory stack by sector. Honest TAM: ~R$ 7M ARR funeral niche; R$ 50-100M aggregate municipal B2G.

## 8. Validation round with Stefany (2026-05-14)

**Organic (WhatsApp, high confidence):** "draft a clarification for the divergences"; "challenge it if appropriate"; "list the risk points". Real artifacts: the Mata Grande analysis (her format, "Pontos de Atenção" section), the Pariconha ofício.

**Critical:** she used ChatGPT to expand the response ("I dropped it into the chat here to help"). Decomposition by confidence:
- **Tier 1 (canonical):** clarification, challenge, risk points, fields of her format.
- **Tier 2 (probable, confirm):** funeral operational analysis (24h, on-call shifts, local base, rural coverage), unfeasibility, supply×service classification, signs of bid-rigging.
- **Tier 3 (LLM framing, do not build):** "risk map" as a dashboard with formal taxonomies; appeal/diligence not organically requested.

**Engagement reading:** resorting to ChatGPT signals non-high enthusiasm. Decision: do not ask for more feedback (it would generate Tier 3); lead by product — deliver something functional, real usage is the true signal. Platform: **web app** (she is an assistant, not a dev — CLI discarded).

## 9. Architecture decision

The enumerative law enricher was **removed from V0** (Stefany did not ask for it; her analysis has no law summary). The pipeline becomes 3 agents in a conditional pipeline (Extractor → Risk Analyst → Drafter). The tool was repurposed: from enumerating laws → grounding the ofício's arguments. A later partial reversal (§12) reintroduced verification surgically.

## 10. Base-rate study (2026-05-15)

24 editais, 13 UFs, a focused schema. **38% cite ≥1 revogada norma; 25% a non-notorious case; 0 municipal revogada** (refutes the municipal-hallucination hypothesis — the city hall cites a law that is in force). The real danger: an old federal infralegal norma copy-pasted (IN SEGES 05/2017 4×, IN SLTI 01/2010 3×, etc.). Accuracy verification (7 cases with a manual answer key): **pure Gemini 4/7 wrong, all false-positive of revogação, conf=high**. Conclusion: common and unsafe → verification returns to V0, but surgical (only the flagged subset, federal verifiable — not the municipal tail).

## 11. Norma Verifier v1 spike (2026-05-15)

Gemini 2.5 Flash + Google Search grounding vs 7 cases: 86% status, 100% scope, caught the 2 worst ones (Law 9.704 nonexistent, Law 6.544 state scope). 1 "dangerous error": IN SEGES 05/2017 (said in force; the answer key said revogada).

## 12. Gap-scan horde + critical correction (2026-05-15)

4 parallel agents (verify pending+audit; gap scan pregão N/NE/CO; concession S/SE; credentialing/auction).

**Critical correction:** the answer key for IN SEGES 05/2017 was **wrong** — inherited from the 1st manual verification (which self-flagged "confirm item 3"). IN 98/2022 did NOT expressly revoke 05/2017; in force, supplementary reception under 14.133, controversial reach. So the v1 spike's "dangerous error" was the **right model, wrong answer key**. Lesson: even diligent manual verification errs on the 1st pass — it validates the curated table with provenance and the containment (received infralegal status = zona-cinzenta, never assert binary).

**Confirmed gaps** (all IN FORCE, enter as an anti-false-positive anchor): regime 14.133 (Dec 11.462/23 SRP, Dec 11.246/22, Dec 11.878/24, Law 12.846/13, LGPD, LC 147/14, Law 12.440/11); concession (Law 8.987/95, 9.074/95, 11.079/04); social assistance (LOAS 8.742/93, Law 12.435/11). Phantom: "Law 13.144/2021" (like 9.704). Result: `data/norma-baseline.json` v0.2 — 25 sourced entries, 5 categories.

## 13. Norma Verifier v2 spike (2026-05-15)

With the injected baseline + corrected answer key: **7/7 status, 7/7 scope, 7/7 via baseline (zero paid grounding), 0 dangerous error**. IN 05/2017 resolves as `incerto` (zona-cinzenta → becomes a question). Gate 1 closed. Gate 2 (deploy/auth): decided Vercel + minimal auth. Both pre-build clean. Verifier cost ≈ zero on the recurring set.

## 14. Prompt convention (2026-05-15)

Decided the standard template for the 4 agents: System (role→rules→few-shot, cacheable) + User (large context→task→output contract, long-context recency). Gold examples = validated real artifacts (3 editais, Mata Grande analysis, Pariconha ofício, baseline per category), versioned as assets.

## 15. Architectural decisions — log

| Date | Decision | Rationale |
|---|---|---|
| 05-13 | Compliance focus (not financial) | Lean MVP, vertical-AI thesis |
| 05-14 | Gemini 2.5 Flash | 4 blocking criteria; $0.06/edital |
| 05-14 | Pure AI SDK, no Mastra V0 | YAGNI until V2 |
| 05-14 | Hexagonal at the ports | provider swap is a 1-liner |
| 05-14 | "Composite regulatory stack" reframe | empirical validation across 15 municipalities |
| 05-14 | Name "Pleito" | decouple from the anchor customer |
| 05-15 | Remove the enumerative enricher from V0 | Tier 1: Stefany did not ask |
| 05-15 | 3-layer Verifier (baseline→grounding→containment) | base rate: model 57% accuracy, unsafe |
| 05-15 | `norma-baseline.json` as a curated asset | moat materialized in V0 |
| 05-15 | Single-edital dashboard + on-demand PDF | triage UX + safety (review before export) |
| 05-15 | Persist content, never the PDF | a free regenerable derivative |
| 05-15 | Deploy Vercel + minimal auth | Stefany accesses by URL |
| 05-15 | Docs by cadence (living SPEC / append-only PROVENANCE / pitch) | distinct update cadences |
| 05-15 | Async architecture: Vercel UI + worker container + jobs | plan-review: a 90-160s pipeline blows the serverless limit |
| 05-15 | `pdftotext`/chromium in the worker's Dockerfile (no Python) | 3 infra blockers collapse under the async decision |
| 05-15 | Gate A runs the baseline matcher over ALL laws | close the extractor's false-negative; remove the phantom "uncertain" signal |
| 05-15 | Eval: property-based Tier 0 in V0; accuracy/decision V1 from telemetry | observability-over-a-priori-eval; real usage defines what to test |
| 05-15 | Auth V0 = env secret + signed cookie (single-user) | decide before the build (it was a vague done gate) |

## 16. Methodological lessons (transferable)

1. Validate premises empirically before building — including the answer key itself (IN 05/2017).
2. Domain expert + LLM = real pain + decorative framing; decompose by confidence (organic × artifact × LLM-expanded).
3. Lukewarm engagement → lead by product, do not ask for more feedback.
4. Schema and baseline evolve against real editais, not hypothesis.
5. Defense in depth: no single security layer is enough; verification hard even manually → curation with provenance + containment.
6. Adversarial plan-review before executing pays 10x: it caught premise and infra holes that would cost dearly in the build.
7. Correct decisions collapse problems: the async choice dissolved 3 infra blockers (timeout, pdftotext, chromium) at once — do not force a new solution (Python) for a problem another decision already solves.
8. Honest eval is driven by failure consequence and real usage, not by the artifacts that accumulated; catastrophic safety is property-based and ships before the 1st use, accuracy is born from telemetry.

---

## 17. Adversarial plan-review of the V0 plan (2026-05-15)

A fresh subagent (plan-review skill) reviewed `docs/plans/2026-05-15-pleito-v0.md` against the real code. Verdict **NEEDS REVISION**, 10 required changes. Blockers:

- **Serverless timeout (SPEC §11 hole):** pipeline ~90-160s; Vercel Hobby 10s / Pro 60-300s. A synchronous route is unviable.
- **`pdftotext` absent on Vercel (SPEC §6/plan hole):** the POC "worked" only locally.
- **Playwright/chromium likewise** in PDF export.
- **"Port without rewriting" false:** `extract.ts`/`spike-verifier.ts` are CLI scripts (`main()`, hardcoded GABARITO, `generateText`+regex), with no `montarPrompt`/model injection; the SPEC §7 few-shot examples **do not exist in the POC**.
- **Gate A false-negative (SPEC §5 logic hole):** triggers only if the extractor flagged `revogada=true`; an "uncertain" signal does not exist in the schema.
- Minor: the `fixtures/editais/jaborandi.zip` fixture does not exist; `numero` normalization not specified (the core of the moat); serverless Prisma (pooling/directUrl/generate); tsconfig `include` does not cover `domain/`; auth deferred; `next@latest` not pinned.

## 18. Architecture correction (2026-05-15)

The 3 infra blockers had a common root cause (the Vercel serverless constraint). Async decision → the pipeline moves to a controlled **worker container**: `pdftotext -layout` (validated in the POC) and chromium return via the Dockerfile; no timeout. **Python not needed** (it would only be justified by a quality the POC already proved sufficient — YAGNI). Vercel stays thin (UI/API/polling/export). See SPEC §3/§4/§14.

## 19. Gate A fix (2026-05-15)

The baseline matcher now runs over ALL `leisReferenciadas` (deterministic local lookup, zero cost), not just the flagged ones. It catches a known revogada law even with the extractor in a false-negative. The "uncertain" signal (nonexistent) was removed from the design. See SPEC §5.

## 20. Eval reframe (2026-05-15)

User critique: the proposed eval was driven by the accumulated artifacts, not by the failure's consequence. Re-derived by damage: #0 a false external ofício (catastrophic, irreversible) → #1 omit/invent a blocker (severe, silent) → #2 critical deadline/requirement → #3 noise → #4 cosmetic. Reframe: catastrophic checks are a **structural property** (they generalize, they do not depend on a corpus). The user's final pivot: **build + observe real usage**; accuracy/decision eval is born from telemetry (V1), not a-priori. **Tier 0 (containment/faithfulness, deterministic) ships in V0** — catastrophic damage cannot "learn from usage". Gold signal: the generated×exported ofício diff. See SPEC §11.
