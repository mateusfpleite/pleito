# Pleito — Especificação

> Documento **vivo**. Estado autoritativo atual do que vamos construir. O "porquê" e a trilha de evidências ficam em `PROVENANCE.md`. Pitch não-técnico para a usuária-âncora em `pitch-stefany.md`.

**Atualizado:** 2026-05-15

---

## 1. Visão & tese

Pleito é um **vertical AI** para análise de licitações B2G municipais brasileiras, com wedge no setor funerário. Cliente-âncora: Zelo (serviços funerários, presença em centenas de municípios).

Tese: o LLM é substrato commodity. O valor sustentável vem do **acúmulo estruturado do stack regulatório composto** (lei municipal + decreto tarifário + edital vigente + VISA local + jurisprudência TJ + contrato incumbente) por município e setor, mais a integração nos workflows do cliente. O moat é dado curado com proveniência — começando já no V0 com `data/norma-baseline.json`.

## 2. Usuário-alvo

- V0–V1: Stefany (analista de licitações única).
- V2+: equipe Zelo (3–5 pessoas).
- V3+: outras empresas B2G municipais.
- V4+: outros verticais municipais (resíduos, transporte escolar, saneamento, merenda).

## 3. Arquitetura

**Stack:** Next.js (App Router) + Vercel AI SDK + Supabase Postgres + Prisma. Ports hexagonais no boundary do LLM. **Sem Mastra no V0** (entra em V2 quando memória/multi-agent justificarem).

**Princípios:**
1. Hexagonal no LLM boundary — `ExtractorPort`, `NormaVerifierPort`, `RiskAnalystPort`, `DrafterPort`. Troca de provider = trocar adapter.
2. YAGNI — nada de framework até caso real.
3. Schema fixo, evoluído contra editais reais (não hipótese).
4. Defense in depth na segurança do Verifier (§5).
5. Persistir conteúdo, nunca artefato derivado (§9).

**Estrutura de pastas:**

```
pleito/
├── app/                      # Next.js (upload, dashboard, export, /api/analyze)
├── domain/                   # tipos, schema Zod, ports (zero dep externa)
├── application/              # workflow analyzeEdital (orquestra + gates)
├── adapters/
│   ├── extractor/            # Gemini Flash
│   ├── verifier/             # baseline + web grounding
│   ├── risk-analyst/
│   ├── drafter/
│   ├── pdf/                  # render on-demand
│   └── repo/                 # Supabase via Prisma
├── data/norma-baseline.json  # ativo curado (moat)
├── infrastructure/           # config, env, factories
├── fixtures/                 # editais de teste
└── docs/                     # SPEC, PROVENANCE, pitch-stefany
```

## 4. Pipeline (7 componentes, 2 gates)

```
upload edital (PDF/texto/zip)
  │
  ▼ 1. Preprocessor [código] — descompacta, pdftotext -layout, normaliza
  ▼ 2. Extractor [agente, Gemini Flash, sem tool] — schema v3; flags revogada PROVISÓRIAS
  │
  ├─ gate A: há lei revogada/incerta? ── não ─┐
  ▼ sim                                        │
  ▼ 3. Norma Verifier [agente, condicional]    │
       baseline curada (precedência) → web     │
       grounding só p/ cauda fora da tabela    │
  │                                            │
  └────────────────────┬───────────────────────┘
  ▼ 4. Risk Analyst [agente] — pontosDeAtencao{severidade,categoria}, consome status VERIFICADO
  │
  ├─ gate B: incoerência sev≥média OU trecho ambíguo OU manifestação recomendada? ── não ─┐
  ▼ sim                                                                                   │
  ▼ 5. Drafter [agente, condicional] — esclarecimento/impugnação; tool lookup_referencia_  │
       legal; só afirma revogação se status verificado=revogada; incerto→pergunta         │
  └────────────────────┬───────────────────────────────────────────────────────────────────┘
  ▼ 6. Renderer [código] — 6a dashboard web (sempre) · 6b export PDF on-demand (botão)
  ▼ 7. Persistence [código] — analyses (JSON) + norma_cache; nunca PDF
```

Modelos: todos Gemini 2.5 Flash. Fallback Haiku 4.5 (tool use) / Sonnet 4.6 (schema). Trocável por env var via adapter.

## 5. Design de segurança do Verifier (3 camadas, defense in depth)

Risco: a flag `revogada` do Extractor é palpite do modelo (base rate mostrou ~57% acurácia, erros confiantes no sentido falso-positivo de revogação). Se vaza pro ofício externo, queima credibilidade da Zelo.

1. **Baseline curada** (`data/norma-baseline.json`) — conjunto recorrente (federal-infralegal + notórias + concessão + assistência social), categorizado: `revogada-notoria`, `revogada-confirmada`, `vigente-ancora` (anti-falso-positivo), `zona-cinzenta` (status disputado → nunca afirmar binário), `citacao-suspeita` (inexistente/escopo/objeto trocado). Hit aqui = determinístico, custo zero.
2. **Web grounding** (Gemini + Google Search) — só para a cauda fora da baseline.
3. **Contenção no Drafter** — no ofício externo, status infralegal nunca é afirmado como fato nu; `zona-cinzenta`/incerto vira pergunta ao órgão; revisão humana obrigatória antes do export.

Nenhuma camada sozinha basta. Spike v2 validou: 7/7 status e escopo via baseline, zero erro perigoso, zero custo de grounding no conjunto recorrente.

`norma-baseline.json` é **ativo acumulável**: cada norma nova verificada vira entrada sourced. É o moat materializado.

## 6. Schema de extração (v3)

Em `src/schema.ts` (a migrar de v2). Campos v3 sobre v2: `plataforma`, `subcontratacao`, `intervaloMinimoLances`, `prazoRecursos`, `informacoesViabilidade`, e a categoria nova **`pontosDeAtencao[]`** (condições contratuais que afetam o licitante — distinta de `incoerencias` factuais e `trechosAmbiguos` interpretativos). `leisReferenciadas[]` carrega flag `revogada` provisória + `statusVerificado` após o Verifier.

## 7. Convenções de prompt

**System message (estático, cacheável):** Papel → regras/constraints → 1-3 few-shot examples dos casos difíceis.

**User message:** `[CONTEXTO/DADO grande primeiro]` → `[TAREFA]` → `[CONTRATO DE SAÍDA]` por último (recência em long-context).

Examples no system = prompt-cacheable (alavanca de custo). Gold examples reais usados como few-shot, versionados como assets:
- Extractor → 3 editais de referência (casos-armadilha)
- Risk Analyst → análise "Principais pontos - Mata Grande" (formato dela)
- Drafter → ofício real de Pariconha
- Verifier → `norma-baseline.json` por categoria

## 8. UI

Tela de resultado = **dashboard single-edital** (painéis seccionados; pontos de atenção/inconsistências/ambíguos em destaque com severidade colorida; tabela de leis com badge de status verificado ✓/✗/⚠). Ofício gerado aparece como **textarea editável** (human-in-the-loop antes de qualquer coisa externa). Dois botões de export PDF (relatório formato dela / ofício). Histórico/busca/comparação = V1.

## 9. Persistência

Persistir **conteúdo**: JSON da análise + texto do ofício como editado pela usuária. **Nunca** persistir PDF (projeção derivada, regenerável grátis). PDF sempre on-demand; render rápido no request. `norma_cache` guarda status verificado (reusável entre editais).

## 10. Modelo & custo

Gemini 2.5 Flash. Custo estimado ~$0.09/edital (extractor domina; ~75%). Single-user (Stefany ~30-50/mês) = <$5/mês. Verifier ficou ~grátis no conjunto recorrente (baseline determinística, sem grounding pago). Alavancas para modo-produto: enxugar output do schema (output = 8x input) > prompt caching (ganha no dev) > model swap (desprezível). Não otimizar no V0 (prematuro).

## 11. Deploy

Vercel. Auth mínima (não pode ser usuário hardcoded em deploy público — Stefany acessa via URL). Chave Gemini: a do projeto empregamed em dev; revisar para deploy.

## 12. Roadmap

**V0 (MVP, em construção)** — escopo refinado pós-validação Stefany:

| Entra | Fora (V1+) |
|---|---|
| Upload + preprocessor | Enricher enumerativo de leis |
| Extractor (schema v3) | Histórico/busca/comparação |
| Norma Verifier (baseline + grounding) | Perfil municipal completo |
| Risk Analyst (pontosDeAtencao) | Compliance check vs perfil empresa |
| Drafter (esclarecimento/impugnação, editável) | Análise operacional detalhada (Tier 2) |
| Dashboard single-edital + export PDF on-demand | Detecção de direcionamento (Tier 2) |
| Persistência (JSON + ofício editado) | Auth multi-usuário robusta |
| Deploy Vercel + auth mínima | |

Critérios de done V0: 3 editais de referência + Mata Grande processam sem erro; schema 100% válido; capa mentirosa/lei revogada/anexo ausente detectados; tempo <90s; custo <$0.10/edital; dashboard funcional; ofício editável; deploy acessível à Stefany.

**V1** (~2 sem) — histórico/busca, comparação edital×edital, perfil municipal (stack composto), perfil Zelo + compliance check, exportação, auth robusta, dedup por hash.

**V2** (~1-2 meses) — biblioteca municipal em pgvector + RAG, chat NLP, memória conversacional (**Mastra entra aqui**), monitor PNCP automático.

**V3** (~3 meses) — multi-agent paralelo (Mastra Workflows), diff cross-município, proposta draft, aprovação interna, observability/eval.

**V4+** — módulo financeiro (cobrança municipal — dor maior do Grupo Z), multi-tenancy, integração ERP, expansão outros verticais B2G municipais.

## 13. Out of scope

Não substituir julgamento jurídico humano · sem proposta automática V0/V1 · sem ERP V0/V1/V2 · só setor funerário até V4 · foco ~200-300 municípios Zelo (não 5.570) · sem mobile (web responsivo).

## 14. Métricas de sucesso

- **V0 (técnica):** schema 100% válido; <90s; <$0.10/edital; erros perigosos de vigência = 0.
- **V1 (adoção):** Stefany usa ≥5×/semana; −≥30% tempo de análise; chefe lê output sem tradução.
- **V2 (moat):** ≥30 análises + ≥50 perfis municipais indexados; Stefany consulta Pleito antes de Claude/ChatGPT genérico.
- **V3 (viralidade interna):** 2+ pessoas Zelo; chefe pede integração financeira.
