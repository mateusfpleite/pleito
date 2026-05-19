# fixtures/gold — corpus de regressão versionado

Extrações **congeladas** do POC, usadas como corpus de regressão
reproduzível. Diferente de `output/` (gitignored, recriável a cada run),
este diretório é **versionado**: garante que o spike-matcher, o gate
Tier 0 e os testes E2E rodem contra um input estável e auditável.

## Proveniência

- **Origem:** extrações geradas no POC pelo pipeline com **Gemini 2.5
  Flash** (`src/extract.ts`), a partir dos editais reais em `fixtures/`.
- **Schema:** `domain/schema.ts` (schema v3 — SPEC §6).
- **Congelado em:** Phase 4 / Task 4.1 do plano
  `docs/plans/2026-05-15-pleito-v0.md`, copiado de `output/` 1:1.

## Arquivos

| Arquivo                | Conteúdo                                                       |
| ---------------------- | -------------------------------------------------------------- |
| `dombasilio.json`      | Extração full (schema v3) — caso valor divergente.             |
| `jaborandi.json`       | Extração full (schema v3) — caso capa mentirosa.               |
| `niteroi.json`         | Extração full (schema v3) — caso valor sigiloso.               |
| `baserate-result.json` | Base rate: **24 editais, 13 UFs**; `allLaws` preserva os casos |
|                        | de lei revogada que sustentam o spike-matcher (0/37            |
|                        | falso-negativo). Sem isto o spike não é reproduzível pós-P4.   |

## Consumidores

- `src/spike-matcher.ts` — lê daqui (antes lia de `output/`); valida o
  bloqueante #1 (falso-negativo do Gate A) contra corpus real,
  reproduzível.
- **Gate Tier 0** (`eval/tier0.ts`, Phase 9) e **E2E**
  (`tests/e2e/corpus.test.ts`, Phase 17) — corpus de regressão.
- `promoverParaCorpus(id)` (Phase 15) grava novas análises curadas aqui.

## Regra

Não editar à mão. Alterações só via promoção curada de telemetria
(Phase 15) ou re-congelamento explícito do POC, sempre com commit
dedicado documentando a mudança de proveniência.
