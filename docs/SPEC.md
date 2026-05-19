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

**#2 — Contenção estrutural REAL (ZERO prosa livre do modelo no ofício externo):** o modelo do Drafter **NÃO escreve NENHUM texto que entre no documento**. Ele emite SOMENTE decisões estruturadas: `tipo`; `selecoes[]` — referências por `{fonte∈{incoerencia,trechoAmbiguo,pontoDeAtencao}, indice}` a achados **JÁ EXISTENTES** na extração (o modelo escolhe O QUE levantar e a ORDEM, **não REDIGE**); e `leisCitadas[]` com **`afirmacaoVigencia ∈ {nenhuma, revogada, vigente}`** (ainda sobrescrito pelo lookup). **NÃO existe campo de texto livre no schema do modelo** (`pontos[].{titulo,argumento}` removido); o Zod `.strip()` descarta qualquer campo extra que o modelo invente — ele nunca chega ao adapter. O **corpo do ofício é montado 100% por TEMPLATES determinísticos do adapter** (`adapters/drafter/gemini.ts`), keyed pelo **TIPO ESTRUTURADO** do achado: incoerência → template por `incoerencia.tipo` (enum; `lei-revogada` roteia pela lógica de vigência); trechoAmbiguo → template com referência por **ÍNDICE não-LLM** ("ponto nº N da análise"); pontoDeAtencao → template por `categoria` (enum). **INVARIANTE EXAUSTIVO (C1 3ª — não whack-a-mole de canal):** todo caractere de `oficio.markdown` é **(a)** literal fixo de template, **(b)** valor de enum restrito (`incoerencia.tipo`, `pontoDeAtencao.categoria`, `tipo` do ofício), **(c)** escalar **NÃO-LLM** (índice, contagem, host curado de URL de baseline), ou **(d)** frase-template determinística de vigência. **NENHUMA string de texto livre de LLM** — nem do modelo do Drafter, nem de QUALQUER campo `z.string()` livre produzido a montante pelo extractor (`trechosAmbiguos[].secaoOndeAparece`, `incoerencia.descricao`, `porQueAmbiguo`, `pontoDeAtencao.descricao`) ou pelo verifier (`fonteVerificacao` de grounding — `VerdictSchema.fonte` é `z.string()` do LLM) — é interpolada, **em lugar nenhum**. `secaoOndeAparece` (campo `z.string()` livre do extractor) **NÃO** é mais slot: vazava verbatim, guardado só pelo tripwire que esta SPEC proíbe como garantia. Afirmação de revogação = frase-**template keyed pelo `statusVerificado` verificado**, só para lei com match ÚNICO + `statusVerificado=revogada`; qualquer outra → pergunta-template neutra. A **proveniência** da revogação é frase **FIXA** ("conforme verificação de vigência registrada na análise"); a `fonteVerificacao` só é citada — e ainda assim **só o HOST** (domínio, escalar não-LLM, allowlist de domínios oficiais), nunca o texto — quando a origem é comprovadamente a **baseline curada** (`matchNorma` → categoria revogada-* de `data/norma-baseline.json`), **nunca** a string de grounding. Por isso "ab-rogada"/"não subsiste"/"eficácia exaurida"/"tacitamente afastada"/etc. são **estruturalmente impossíveis** de aparecer — **não há canal por onde texto livre de LLM (modelo OU extração/verificação) escreva no documento**; não são "filtradas". Lookup robusto: `numero/ano=null` ou chave `numero|ano` não-única → não-identificável → sempre `nenhuma`/neutro. **O scan léxico (no adapter e no Tier 0) é TRIPWIRE DEFENSIVO, NÃO o mecanismo de contenção:** a garantia é a ausência de prosa livre; se o tripwire disparar (markdown casa léxico sem lei revogada verificada) é **bug estrutural** (um template introduziu prosa de status) → hard fail. Regex expandido (`ab-rogad|derrogad|revogou-se|não subsiste|superad|exaurid|deixou de produzir efeitos|não vige|sem eficácia|não está em vigor|…`) é defesa-em-profundidade, não a barreira. **Mapa `categoriaParaStatus` centralizado** em `domain/categoria-status.ts` (fonte única; Verifier e Tier 0 importam — mapeamento de segurança sem cópia divergível).

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
- Para cada lei citada no ofício: `afirmacaoVigencia=revogada` **só** se `statusVerificado=revogada` (confronto do campo estruturado do Drafter, §5 #2 — não regex em prosa). **Gate duro = 0 violações.** A contenção é **estrutural** pelo **invariante exaustivo** (§5 #2): o documento externo é montado SÓ de literais/enums/escalares-não-LLM/frases-template de vigência — **nenhuma string de texto livre de LLM** (do modelo do Drafter OU de QUALQUER campo `z.string()` livre da extração/verificação — `secaoOndeAparece`, `*.descricao`, `porQueAmbiguo`, `fonteVerificacao` de grounding) é interpolada, em lugar nenhum. O tripwire léxico é detector de regressão DEFENSIVO que NUNCA deveria disparar, **não a garantia**. Este Tier 0 é redundância de verificação, não a barreira única.
- **Tripwire defensivo (NÃO o mecanismo de contenção):** scan léxico amplo de revogação no markdown — o Drafter já o aplica internamente; aqui o Tier 0 reconfere — se dispara mas não há lei revogada verificada que o respalde, é **bug estrutural** (um template introduziu prosa de status, OU um slot voltou a interpolar string livre de LLM) → falha. Nunca deveria disparar; a garantia é o invariante exaustivo (zero string livre de LLM), não este scan. **Limite conhecido:** o tripwire só pega *léxico* de revogação; prosa de status SEM esse léxico ("tacitamente afastada", "já não produz efeito") passaria silenciosa — exatamente por isso a garantia NÃO pode ser o tripwire, e sim a ausência estrutural de qualquer slot de string livre (testado por testes adversariais de AUSÊNCIA ESTRUTURAL, não regex-absence).
- Nenhuma norma da `norma-baseline.json` resolvida com status divergente da tabela (mapa `categoriaParaStatus` centralizado em `domain/categoria-status.ts`, importado por Verifier e Tier 0). **Honestidade de cobertura:** no corpus gold do POC esta checagem é inerte (tudo `nao-verificado`); a fixture sintética versionada `fixtures/gold/synthetic-verificado.json` (1 lei `statusVerificado` divergente da baseline) é tratada pelo runner em modo auto-teste — DEVE produzir a violação `baseline-divergente`, senão a checagem está quebrada → gate falha. Assim a checagem 3 é efetivamente exercitada.
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

> **Runbook operacional acionável (passo-a-passo, env vars exatas,
> resíduos consolidados, checklist Done V0): [`docs/DEPLOY.md`](DEPLOY.md).**
> Esta seção registra só as DECISÕES de arquitetura de deploy; os passos
> de execução não são duplicados aqui.

- **Vercel:** Next.js (Node runtime nas rotas com Prisma). `DATABASE_URL` pooled (Supabase pgBouncer, `?pgbouncer=true&connection_limit=1`), `directUrl` p/ migrations, `prisma generate` no `postinstall`.
- **Worker:** container (Railway/Cloud Run, scale-to-zero), Dockerfile `apt-get install poppler-utils chromium`; conexão Postgres direta. **#3 wake-up:** `/api/job` (Vercel) faz `POST` HTTP no endpoint do worker ao criar o job — *essa requisição acorda o container* (scale-to-zero só desperta por HTTP, não por linha no DB; polling cego não funciona dormindo). **#3 lock:** claim atômico `UPDATE jobs SET status='running' WHERE id=(SELECT id FROM jobs WHERE status='pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *` — dois workers nunca pegam o mesmo job.
- **Auth (#7, decidida):** V0 single-user. `APP_SECRET` em env. `/login` = form com campo de senha → `POST /api/login` valida contra `APP_SECRET` → set-cookie de sessão assinado (HMAC, httpOnly). Middleware protege tudo exceto `/login`, `/api/login`, `/api/health`. O segredo é passado à Stefany fora-de-banda (mensagem direta). Supabase Auth fica pra V1 multi-usuário.
- Chave Gemini: a do empregamed em dev; revisar p/ deploy.
- **Resíduo Phase 12 (preciso):** `WORKER_URL` = URL **pública** do endpoint do worker (a Vercel não alcança rede privada do container). Worker container abre conexão Postgres **DIRETA** (sem pgBouncer; pool próprio). Rotas Vercel que tocam Prisma já com `runtime='nodejs'` (feito). Falta no deploy: provisionar o container (Railway/Cloud Run), publicar a URL, setar `WORKER_URL` na Vercel, instalar `@prisma/adapter-pg pg` e rodar `prisma migrate deploy` via `DIRECT_URL` (ver `adapters/repo/client.ts`).
- **Liveness sem sweeper (caveat V0):** não há sweeper/cron de jobs `pending`. O `/api/job` acorda o worker por HTTP (#3); se esse trigger falhar, o job sobrevive `pending` e é repescado no **próximo** wake do worker (`claimNext`). Mas worker permanentemente fora ⇒ jobs ficam `pending` indefinidamente (nenhum re-trigger automático). Aceitável single-user V0 (operador reenvia); **revisitar V1** com cron/healthcheck que re-dispara pendentes.
- **Limite de body (concern de deploy):** Vercel **Hobby** corta request body em **~4.5 MB** no platform, ANTES do código (413 opaco do edge). `/api/job` aplica um guard UPSTREAM próprio — `MAX_UPLOAD_BYTES = 8 MiB` (pré-base64), barrando com **413** claro antes de empacotar/persistir (base64 infla ~33 % → `inputRef` ~10.7 MiB, ainda << cap de descompressão de 50 MB). Editais do corpus < ~5 MB, então o guard cobre o caso real; uploads de 4.5–8 MiB só passam fora do Hobby (resolver com plano Pro / body maior é resíduo de deploy).
