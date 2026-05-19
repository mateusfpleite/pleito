# Pleito — Especificação

> Documento **vivo**. Estado autoritativo atual. "Porquê" e trilha de evidências em `PROVENANCE.md`. Pitch não-técnico em `pitch-stefany.md`.

**Atualizado:** 2026-05-15 (rev. pós plan-review: arquitetura async/worker + observabilidade)

---

## 1. Visão & tese

Vertical AI para análise de licitações B2G municipais brasileiras, wedge no setor funerário. Cliente-âncora: Zelo. O LLM é substrato commodity; o valor vem do **acúmulo estruturado do stack regulatório composto** por município/setor + integração no workflow do cliente. Moat = dado curado com proveniência (`data/norma-baseline.json`), começando no V0.

## 2. Usuário-alvo

V0–V1 Stefany (analista única) · V2+ equipe Zelo · V3+ outras empresas B2G municipais · V4+ outros verticais.

## 3. Arquitetura

**Split de execução (decisão pós plan-review):**

- **Vercel / Next.js** — só o que é rápido e request-scoped: UI/dashboard, auth, upload (cria job), polling de status, export PDF on-demand.
- **Worker container** (Railway ou Cloud Run, scale-to-zero, Dockerfile com `poppler-utils` + chromium) — roda o pipeline de 7 componentes. **Fora do modelo serverless**: sem limite de timeout, com binários de sistema. Reaproveita TODO o código TS validado.
- **Supabase Postgres** — `jobs`, `analyses`, `norma_cache`, telemetria.

Princípios: hexagonal no LLM boundary (ports trocáveis por env var) · YAGNI (sem Mastra até V2) · schema evoluído contra editais reais · defense in depth na segurança do Verifier · persistir conteúdo nunca derivado.

**Reaproveitamento (corrigido pós plan-review):** reaproveita-se **prompts validados, `data/norma-baseline.json` e o schema**; o I/O dos scripts CLI (`src/extract.ts`, `src/spike-verifier.ts`) é **reescrito** como adapters (eram `main()`+`process.exit`, não módulos). "Reaproveitar tudo" era impreciso.

**Estrutura de pastas:**

```
pleito/
├── app/                  # Next.js (Vercel): upload, dashboard, /api/{job,status,export}
├── worker/               # entrypoint do worker container (loop de jobs)
├── domain/               # tipos, schema Zod, ports, baseline matcher (zero dep)
├── application/          # workflow analyzeEdital (orquestra + 2 gates)
├── adapters/             # extractor, verifier, risk-analyst, drafter, pdf, repo, telemetry
├── data/norma-baseline.json
├── infrastructure/       # config, factories, env
├── eval/                 # Tier 0 gate determinístico (property-based)
├── fixtures/             # corpus de validação
└── docs/
```

## 4. Pipeline (async, no worker)

```
Vercel: upload → cria job(status=pending) → retorna jobId   │  dashboard faz polling /api/status/:id
                          │                                  ▲
                          ▼ worker pega job (status=running)  │ status/result
  1. Preprocessor [código] zip/gz/pdf → texto (pdftotext -layout, roda no container)
  2. Extractor   [Gemini Flash, sem tool] schema v3; flags revogada PROVISÓRIAS
  3. gate A: baseline matcher em TODAS as leis (determinístico, custo zero) →
       dispara verificação se matcher ∈ {revogada-*, zona-cinzenta, citacao-suspeita}
       OU extractor marcou revogada=true   [fecha falso-negativo]
  4. Norma Verifier [condicional] baseline (precedência) → web grounding (cauda) → cache
  5. Risk Analyst  pontosDeAtencao{severidade,categoria}, consome status VERIFICADO
  6. gate B: incoerência sev≥média OU trecho ambíguo OU recomendaManifestacao
  7. Drafter [condicional] esclarecimento/impugnação; só afirma revogação se
       statusVerificado=revogada; senão → pergunta ao órgão
  → grava analyses + telemetria; job status=done
```

Modelos: Gemini 2.5 Flash (fallback Haiku 4.5 tool / Sonnet 4.6 schema), via env por adapter.

## 5. Segurança do Verifier (3 camadas, defense in depth)

Risco: flag `revogada` do Extractor é palpite (~57% acurácia, viés falso-positivo). Se vaza pro ofício externo → dano irreversível à credibilidade da Zelo.

1. **Baseline curada** (`data/norma-baseline.json`) — categorias: `revogada-notoria`, `revogada-confirmada`, `vigente-ancora` (anti-falso-positivo), `zona-cinzenta` (nunca binário), `citacao-suspeita`. Hit = determinístico, custo zero.
2. **Web grounding** (Gemini + Google Search) — só cauda fora da baseline.
3. **Contenção no Drafter** — status infralegal nunca afirmado como fato nu no ofício externo; zona-cinzenta/não-verificado → pergunta; revisão humana obrigatória antes do export.

**Gate A fecha o falso-negativo:** o baseline matcher roda em TODAS as `leisReferenciadas` (lookup local, sem LLM, grátis), não só nas que o extractor marcou. Lei revogada conhecida é pega mesmo se o extractor disse `revogada=false`. Não existe sinal "incerto" no schema — removido; o gatilho é matcher-classifica-risco OU extractor-flag.

**Design do matcher (validado empiricamente — spike `src/spike-matcher.ts` contra 99 leis reais de `output/*.json`):** match **número+ano-primário**; `escopo`/`tipoNorma` são sinais **soft** (fallback tolerante que ignora ambos), porque o extractor erra escopo/tipo em ~54% das citações. `normalizarNumero` aplicado nos **dois lados** (extractor produz `"14133"`, baseline tem `"14.133"`). Resultado: falso-negativo **0/37** com normalização+fallback vs **23/37 (62%)** com match estrito não-normalizado (o bug que o plano mascarava). Match estrito sozinho pegaria só 46%. **Risco residual registrado:** colisão número+ano entre lei federal e estadual distintas não ocorreu no corpus — não refutado; mitigação: fallback prefere escopo quando presente, entradas `citacao-suspeita` sinalizam em vez de silenciar.

**#2 — Contenção estrutural (markdown determinístico, não prosa livre do modelo):** o modelo do Drafter NÃO escreve o ofício nem qualquer frase de (não)vigência. Ele produz só, por ponto a questionar, `{titulo, argumento}` (divergência factual + questionamento) e `leisCitadas[]` com **`afirmacaoVigencia ∈ {nenhuma, revogada, vigente}`**. O **markdown final é montado DETERMINISTICAMENTE pelo adapter** (`adapters/drafter/gemini.ts`): afirmações de vigência são frases-**template keyed pelo `statusVerificado` verificado** — só uma lei com match ÚNICO em `leisReferenciadas` e `statusVerificado=revogada` recebe a frase de revogação; qualquer outra → pergunta-template neutra. Logo o vazamento de revogação em prosa livre é **estruturalmente impossível** (não há prosa livre). Lookup robusto: `numero/ano=null` ou chave `numero|ano` não-única → não-identificável → sempre `nenhuma`/neutro (jamais afirma revogação por match ambíguo). **Backstop léxico no próprio adapter** (defense-in-depth): cada `argumento` escrito pelo modelo passa por scan léxico amplo de vigência (`/revogad|perdeu vigência|…/i`); se casar, o ponto é rebaixado para fraseado-pergunta neutro (descarta o texto do modelo). O ofício neutro determinístico é lexicon-safe por construção (fraseado por categoria/tipo, nunca interpola `descricao` verbatim). Tier 0 (§11a) confronta `afirmacaoVigencia` vs `statusVerificado` e roda o scan léxico como **backstop estrutural** — não é mais o único guard do vazamento de prosa.

`norma-baseline.json` é ativo acumulável (moat).

## 6. Schema de extração (v3)

Em `domain/schema.ts` (migrar de `src/schema.ts` v2). Sobre v2: `plataforma`, `subcontratacaoPermitida`, `intervaloMinimoLances`, `prazoRecursosDiasUteis`, `informacoesViabilidade`, e `pontosDeAtencao[]` (`{descricao, categoria∈{financeiro,operacional,juridico,competitivo}, severidade∈{alta,media,baixa}, recomendaManifestacao}`). `leisReferenciadas[]` ganha `statusVerificado∈{vigente,revogada,contestada,inexistente,nao-verificado}` (default `nao-verificado`) + `fonteVerificacao`. **Não há campo "incerto" no output do extractor** (era premissa fantasma).

## 7. Convenções de prompt

System (estático, cacheável): papel → regras → 1-3 few-shot. User: `[contexto grande]` → `[tarefa]` → `[contrato de saída]` (recência long-context). Few-shot **não existem no POC — devem ser criados** a partir dos gold reais (3 editais-armadilha; análise Mata Grande; ofício Pariconha; baseline por categoria), versionados como assets.

## 8. UI

Dashboard single-edital: painéis seccionados; pontos de atenção/inconsistências/ambíguos em destaque por severidade; tabela de leis com badge de `statusVerificado` (✓/✗/⚠); ofício como textarea editável (human-in-the-loop). Estado de processamento via polling do job. Botões export PDF on-demand. Histórico/busca/comparação = V1.

## 9. Persistência

Persistir conteúdo: JSON da análise + ofício **gerado** e **como exportado** (o diff entre os dois é sinal de eval — §11b). Nunca PDF (derivado regenerável). `jobs` (status/erro), `norma_cache` (status verificado reusável). PDF sempre on-demand.

## 10. Modelo & custo

Gemini 2.5 Flash. ~$0.09/edital (extractor ~75%). Single-user <$5/mês. `pdftotext -layout` roda no worker container (problema do binário Vercel **dissolvido** pela arquitetura async). Verifier ≈ grátis no conjunto recorrente (baseline determinística). Alavancas modo-produto: enxugar output > caching (dev) > model swap (desprezível). Não otimizar no V0.

## 11. Verificação & Observabilidade

**11a. Gate Tier 0 (embarca no V0, property-based, determinístico, custo zero, toda mudança):** invariantes estruturais, não comparação com corpus, logo generalizam pra editais nunca vistos:
- Para cada lei citada no ofício: `afirmacaoVigencia=revogada` **só** se `statusVerificado=revogada` (confronto do campo estruturado do Drafter, §5 #2 — não regex em prosa). **Gate duro = 0 violações.** A contenção PRIMÁRIA é a montagem determinística do markdown no Drafter (afirmações de vigência = templates keyed pelo `statusVerificado` verificado; modelo nunca escreve vigência livre) — este Tier 0 é redundância de verificação, não a barreira única.
- Backstop estrutural (não único guard): scan léxico amplo de revogação no markdown — o Drafter já o aplica internamente sobre os segmentos do modelo; aqui o Tier 0 reconfere — se dispara mas `afirmacaoVigencia=nenhuma`, é inconsistência → falha (defense-in-depth).
- Nenhuma norma da `norma-baseline.json` resolvida com status divergente da tabela.
- zona-cinzenta nunca vira binário no ofício.
Roda em `eval/`. Falhou → build falha. Não depende de uso da Stefany — protege o dano catastrófico desde o 1º uso.

**11b. Observabilidade (V0):** sinais implícitos (fricção zero) > explícitos:
- **Diff ofício gerado × exportado** (sinal-ouro: rótulo direto e não-supervisionado de erro/lacuna do Drafter).
- Export/quais artefatos, re-upload do mesmo edital, painéis abertos, latência, custo.
- Explícito mínimo: 👍/👎 + texto opcional por análise; micro-pergunta rotativa.
- **Custo por chamada de grounding** logado individualmente (não só agregado) — a cauda municipal real aciona grounding pago; bomba silenciosa se não instrumentado.
- Fallback de sinal: se o diff ofício gerado×exportado vier vazio (ela aceita sem editar / não exporta), o sinal-ouro é nulo — usar export-sim/não + 👍/👎 como sinal de reserva.
- **Superfície de revisão** interna (lista de análises + feedback + diffs) — sem isso o loop não fecha.
- **Promote-to-corpus** em 1 passo grava em **`fixtures/gold/` (versionado, NÃO em `output/` que é gitignored)** — vira fixture de regressão do Tier 0/E2E.

**11c. Evals de acurácia/decisão = V1**, construídos a partir da telemetria coletada (não a-priori). Eixo: propriedade-primeiro / corpus-por-cobertura-de-falha, não corpus-centric.

## 12. Roadmap

**V0 (em construção)** — escopo:

| Entra | Fora (V1+) |
|---|---|
| Vercel UI + worker container + jobs async | Histórico/busca/comparação |
| Preprocessor (pdftotext no container) | Perfil municipal completo |
| Extractor (schema v3) | Compliance vs perfil empresa |
| Norma Verifier (baseline + grounding) | Análise operacional detalhada (Tier 2) |
| Risk Analyst (pontosDeAtencao) | Detecção de direcionamento (Tier 2) |
| Drafter (esclarecimento/impugnação editável) | Evals de acurácia/decisão |
| Dashboard + export PDF on-demand | |
| **Gate Tier 0** + **observabilidade/feedback** | |
| Persistência + deploy (Vercel+worker+Supabase) | |

Done V0: 3 editais ref + Mata Grande sem erro; schema 100% válido; capa-mentirosa/lei-revogada/anexo-ausente detectados; **Gate Tier 0 = 0 violações**; pipeline completo no worker sem timeout; dashboard funcional; ofício editável; telemetria gravando; deploy acessível à Stefany.

**V1** histórico/busca, comparação, perfil municipal, perfil Zelo+compliance, evals de acurácia (da telemetria), auth robusta. **V2** biblioteca pgvector+RAG, chat NLP, memória (**Mastra**), monitor PNCP. **V3** multi-agent paralelo, diff cross-município, proposta draft. **V4+** financeiro (cobrança municipal), multi-tenancy, ERP, outros verticais.

## 13. Out of scope

Não substituir julgamento jurídico · sem proposta automática V0/V1 · sem ERP V0/V1/V2 · só funerário até V4 · ~200-300 municípios Zelo · sem mobile.

## 14. Deploy

- **Vercel:** Next.js (Node runtime nas rotas com Prisma). `DATABASE_URL` pooled (Supabase pgBouncer, `?pgbouncer=true&connection_limit=1`), `directUrl` p/ migrations, `prisma generate` no `postinstall`.
- **Worker:** container (Railway/Cloud Run, scale-to-zero), Dockerfile `apt-get install poppler-utils chromium`; conexão Postgres direta. **#3 wake-up:** `/api/job` (Vercel) faz `POST` HTTP no endpoint do worker ao criar o job — *essa requisição acorda o container* (scale-to-zero só desperta por HTTP, não por linha no DB; polling cego não funciona dormindo). **#3 lock:** claim atômico `UPDATE jobs SET status='running' WHERE id=(SELECT id FROM jobs WHERE status='pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *` — dois workers nunca pegam o mesmo job.
- **Auth (#7, decidida):** V0 single-user. `APP_SECRET` em env. `/login` = form com campo de senha → `POST /api/login` valida contra `APP_SECRET` → set-cookie de sessão assinado (HMAC, httpOnly). Middleware protege tudo exceto `/login`, `/api/login`, `/api/health`. O segredo é passado à Stefany fora-de-banda (mensagem direta). Supabase Auth fica pra V1 multi-usuário.
- Chave Gemini: a do empregamed em dev; revisar p/ deploy.
