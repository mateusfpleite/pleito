# Pleito V0 — Runbook de Deploy

> Runbook **único, acionável**, que consolida TODOS os resíduos de deploy
> acumulados pelas Phases 0–17. Estado de código: **273 testes verdes,
> typecheck limpo, `pnpm build` OK, `pnpm eval:tier0` = 0 violações**. O
> que falta é EXCLUSIVAMENTE infra externa (Postgres real, Vercel,
> container do worker, chave Gemini de produção) — nenhum bug de código
> pendente. SPEC §14 aponta para cá; não duplicar conteúdo lá.

Arquitetura (SPEC §3): **Vercel/Next.js** (UI, auth, upload→job, polling,
export) ↔ **Supabase Postgres** (jobs/analyses/norma_cache/telemetria) ↔
**worker container** scale-to-zero (pipeline de 7 componentes, poppler +
chromium).

---

## 1. Banco — Supabase Postgres

1. Criar projeto no Supabase. Anotar a senha do Postgres.
2. Duas URLs (Supabase as expõe em *Project Settings → Database*):
   - **`DATABASE_URL`** = connection string **pooled** (pgBouncer, porta
     6543), com **`?pgbouncer=true&connection_limit=1`**. Usada pelas
     rotas Vercel (serverless-safe).
   - **`DIRECT_URL`** = connection string **direta** (porta 5432, sem
     pgBouncer). Usada por `prisma db push` / `migrate deploy` (pgBouncer
     não aceita DDL transacional) e pelo worker.
3. Instalar o driver adapter (Prisma 7 removeu a query-engine binária
   default — `PrismaClient` exige driver adapter em runtime):
   ```
   pnpm add @prisma/adapter-pg pg
   pnpm add -D @types/pg
   ```
4. **Trocar o corpo de `criarPrismaClient()`** em
   `adapters/repo/client.ts`. O snippet EXATO já está comentado no header
   desse arquivo (RESÍDUO DE BANCO, item "Trocar o corpo…"):
   ```ts
   import { PrismaClient } from '../../prisma/generated/client.ts';
   import { PrismaPg } from '@prisma/adapter-pg';
   return new PrismaClient({
     adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
   });
   ```
   Hoje a função lança um erro acionável (`RESÍDUO de banco…`) — é o único
   ponto de código que muda no deploy.
5. **Aplicar o schema.** NÃO há pasta `prisma/migrations/` — o projeto usa
   **`prisma db push`** (schema-first, sem histórico de migration). Rodar
   contra a **`DIRECT_URL`**:
   ```
   DIRECT_URL=<direta> DATABASE_URL=<direta> pnpm prisma db push
   ```
   (ou `prisma migrate deploy` se/quando migrations forem introduzidas —
   V1). **TODAS as colunas do schema atual têm de ir**, em 4 models
   (`prisma/schema.prisma`): `Job`, `Analysis` (incl.
   **`oficioExportado`** + **`oficioExportadoEm`**), `NormaCache`,
   `Telemetria`. `prisma generate` já roda no `postinstall` (offline, já
   validado neste ambiente).
6. **`prisma.config.ts` — ARMADILHA (Phase 11 review Minor #1):** hoje o
   arquivo seta `shadowDatabaseUrl: directUrl` (e
   `datasource.shadowDatabaseUrl: directUrl`). Isso é **inofensivo para
   `db push`/`migrate deploy`** (não usam shadow DB), mas **catastrófico
   se alguém rodar `prisma migrate dev`**: o `migrate dev` **RESETA** o
   banco apontado por `shadowDatabaseUrl`. Apontar shadow para a
   `DIRECT_URL` de produção = **reset da DB de produção**. Antes do
   deploy, em `prisma.config.ts`: **OMITIR `shadowDatabaseUrl`** (deploy
   só usa `db push`/`migrate deploy`, que não precisam dele) OU apontá-lo
   para um **banco throwaway distinto** (jamais a produção). Nunca rodar
   `migrate dev` com a config atual contra produção.

---

## 2. Vercel — Next.js

Deploy do repo (App Router). Rotas que tocam Prisma já estão com
`runtime='nodejs'` (feito — não há ação).

**Env vars (exatas) no projeto Vercel:**

| Var | Valor | Notas |
|---|---|---|
| `GOOGLE_GENERATIVE_AI_API_KEY` | chave Gemini de **produção** | Em DEV usa-se a do empregamed; **revisar/rotacionar para produção** (chamadas reais custam). |
| `DATABASE_URL` | URL **pooled** (`?pgbouncer=true&connection_limit=1`) | Rotas serverless. |
| `DIRECT_URL` | URL **direta** | Exigida pelo `config.ts` (Zod `.min(1)`); usada por migrações. |
| `APP_SECRET` | segredo de sessão (HMAC) | Auth single-user (SPEC §14 #7). **Passar à Stefany fora-de-banda** (mensagem direta), nunca no repo. |
| `WORKER_URL` | URL **pública** do worker (ver §3) | A Vercel faz `POST` aqui ao criar o job (wake-up scale-to-zero). |
| `EXTRACTOR_MODEL` | opcional | Default `gemini-2.5-flash`. |

**Limite de body (concern de deploy):** o plano **Hobby** da Vercel corta o
request body em **~4.5 MB no edge**, ANTES do código (413 opaco). O guard
upstream do `/api/job` é **`MAX_UPLOAD_BYTES = 8 MiB`**
(`app/api/job/handler.ts`) — maior que o corte do Hobby. Consequência:
editais entre ~4.5 e 8 MiB recebem **413 do edge** (não o 413 claro do
guard) no Hobby. **Mitigação:** usar plano **Pro** (body maior) OU aceitar
o 413 do edge para esse intervalo. Os editais do **corpus real são < ~5
MB**, então o caso real é coberto; uploads de 4.5–8 MiB só passam fora do
Hobby. Resolver com Pro/body maior é resíduo de deploy (sem mudança de
código).

---

## 3. Worker container — Railway ou Cloud Run (scale-to-zero)

O worker roda o pipeline de 7 componentes fora do modelo serverless (sem
limite de timeout, com binários de sistema). `Dockerfile` já pronto.

1. **Build da imagem:** o `Dockerfile` (raiz) já faz
   `apt-get install -y poppler-utils chromium` sobre `node:20-slim`,
   `pnpm install --frozen-lockfile`, `CMD ["pnpm","worker"]`.
2. **Dependências opcionais:** `playwright-core` está em
   `optionalDependencies` (export PDF via chromium). `pnpm install`
   instala `optionalDependencies` por **default** (não passar
   `--no-optional`). O `--frozen-lockfile` do Dockerfile mantém isso.
3. **chromium path:** `adapters/pdf/render.ts` usa `/usr/bin/chromium`
   (pacote Debian no `node:20-slim`), **sobrescrevível por
   `CHROMIUM_PATH`**. Em Railway/Cloud Run com a imagem do Dockerfile o
   default já resolve.
4. **Env vars do worker:**
   | Var | Valor |
   |---|---|
   | `DATABASE_URL` | conexão **DIRETA** (NÃO pooled — o worker abre pool próprio; pgBouncer atrapalha `FOR UPDATE SKIP LOCKED` e pool aninhado). Use a `DIRECT_URL`. |
   | `GOOGLE_GENERATIVE_AI_API_KEY` | mesma chave de produção. |
   | `EXTRACTOR_MODEL` | opcional (default `gemini-2.5-flash`). |
   | `PORT` | porta exposta do container (worker lê `process.env.PORT ?? 8080`, `worker/index.ts`). |
   | `CHROMIUM_PATH` | opcional (default `/usr/bin/chromium`). |
5. **Publicar a URL pública** do serviço (Railway/Cloud Run dão um
   domínio público) e **setar `WORKER_URL` na Vercel** com essa URL. A
   Vercel NÃO alcança rede privada do container — a URL precisa ser
   pública.
6. **Conectividade Vercel → worker:** `POST /api/job` (Vercel) cria o Job
   `pending` e faz **`POST` em `WORKER_URL`** — essa requisição HTTP é o
   que **acorda** o container scale-to-zero (ele não desperta por linha no
   DB; polling cego dormindo não funciona). Ao receber o POST o worker
   drena a fila inteira via `drenarFila` (claim atômico `UPDATE … FOR
   UPDATE SKIP LOCKED … RETURNING *` — dois workers nunca pegam o mesmo
   job). `/healthz` disponível para probes.

---

## 4. Caveat de liveness (sem sweeper) — aceitável V0

NÃO há sweeper/cron de jobs `pending`. Fluxo: `/api/job` acorda o worker
por HTTP; se esse trigger falhar, o Job sobrevive `pending` e é
**repescado no próximo wake** do worker (`claimNext` drena tudo). Mas se o
worker ficar **permanentemente fora**, jobs ficam `pending`
indefinidamente — **não há re-trigger automático**. **Aceitável
single-user V0** (a operadora reenvia). **Revisitar V1** com
cron/healthcheck que re-dispara pendentes.

---

## 5. Checklist Done V0 (SPEC §12) — honesto

### Verde OFFLINE (validado neste ambiente, sem infra)

- [x] **Schema 100% válido** — `domain/schema.test.ts` + E2E
  `tests/e2e/corpus.test.ts` (cada gold reconstrói e parseia
  `EditalExtractionSchema`).
- [x] **`pnpm eval:tier0` = 0 violações** (gate duro estrutural) — runner
  `eval/run-tier0.ts` sobre `fixtures/gold/*` + auto-teste sintético
  `synthetic-verificado.json` (checagem 3 efetivamente exercitada).
- [x] **Capa-mentirosa / lei-revogada / anexo-ausente detectados** — como
  invariante determinística sobre o corpus-ouro do POC: Jaborandi
  registra `incoerencia` objeto-divergente (sev. alta) + `lei-revogada`
  e suas 8666/1993 + 10520/2002 casam baseline `revogada-notoria`;
  Niterói regime `lei-13303` + anexo `presenteNoArquivo=false`; Dom
  Basílio `valor-divergente` sev. alta. (`tests/e2e/corpus.test.ts`).
- [x] **Contenção estrutural** — `eval/tier0.test.ts` (property-based) +
  Tier 0 fatal no `application/analyze-edital.ts` + `checarContencao`
  sobre cada gold com `oficio:null` → 0 violações.
- [x] Pipeline/worker/gates/persistência/auth **unit + integração com
  mocks** verdes (273 testes; `worker/processar.test.ts`,
  `adapters/repo/repo.test.ts`, `app/api/**`, `lib/middleware-auth`,
  etc.).

### Só fecha PÓS-DEPLOY (requer infra real — não é bug de código)

- [ ] **3 editais ref + Mata Grande sem erro** via worker REAL (Gemini
  2.5 Flash + Postgres) — qualidade de extração valida-se em produção
  via telemetria (SPEC §11c), não como teste que falha offline.
- [ ] **Pipeline completo no worker sem timeout** (Done V0: < 90 s) —
  medível só com Gemini + container reais.
- [ ] **Job trigger + claim atômico** ponta-a-ponta em Postgres real
  (lógica testada com mock; `FOR UPDATE SKIP LOCKED` exige PG real).
- [ ] **Dashboard + ofício editável + PDF on-demand** e2e (chromium real
  no container; sem chromium no DEV).
- [ ] **Telemetria gravando** em Postgres real.
- [ ] **Deploy acessível à Stefany** (URL Vercel pública + `APP_SECRET`
  entregue fora-de-banda).

> Critério de aceite pós-deploy: subir os 3 editais de referência +
> Mata Grande pela UI; cada job conclui `done` < 90 s; `pnpm eval:tier0`
> continua 0; dashboard renderiza todos os painéis; export PDF retorna
> buffer `%PDF`; telemetria registra `submissao`/`analise_concluida`.

---

## 6. Resíduos de PRODUTO (não de deploy — registrar p/ discussão)

Não bloqueiam o deploy; são decisões/hardening de produto a discutir:

1. **Ofício 100% templated** (SPEC §5 #2): contenção estrutural total
   torna o ofício rígido (zero prosa livre do LLM). Trade-off
   utilidade × segurança — mitigado pelo **human-in-the-loop** (a
   Stefany edita o textarea antes de exportar). Avaliar se a rigidez
   reduz utilidade percebida.
2. **Identificadores de cabeçalho do ofício** (`razaoSocial`, `numero`
   do edital) são `z.string()` **livres do extractor** interpolados no
   cabeçalho do ofício. Risco baixo (não são status legal; não há fonte
   não-LLM para esses campos), mas são a única string de origem-LLM no
   documento. Registrar como exceção consciente ao invariante exaustivo.
3. **Colisão de nome em `promovido-*.json`** (Phase 15): o
   `promoverParaCorpus` grava `promovido-<municipio>-<uf>.json`; duas
   promoções do mesmo município/UF **sobrescrevem silenciosamente** a
   anterior. Hardening V1 (sufixo único / detecção de colisão).
4. **Polling do dashboard — erros HTTP não-404:** o cliente de polling
   trata 404 mas respostas de erro não-404 caem em `r.json()` e podem
   quebrar o parse silenciosamente. Hardening V1 (tratamento explícito
   de 5xx/timeout no polling).

---

## 7. Sequência mínima de deploy (resumo acionável)

1. Supabase: criar projeto → obter `DATABASE_URL` (pooled) + `DIRECT_URL`.
2. `pnpm add @prisma/adapter-pg pg && pnpm add -D @types/pg`.
3. Editar `adapters/repo/client.ts` (snippet comentado no header).
4. Ajustar `prisma.config.ts`: **remover `shadowDatabaseUrl`** (ou apontar
   p/ DB throwaway). NUNCA `migrate dev` contra produção.
5. `prisma db push` via `DIRECT_URL` (cria os 4 models inteiros).
6. Vercel: deploy + env vars da §2 (`APP_SECRET` fora-de-banda).
7. Worker: build do Dockerfile → Railway/Cloud Run scale-to-zero; env da
   §3 (`DATABASE_URL` = DIRETA, `PORT`).
8. Publicar URL pública do worker → setar `WORKER_URL` na Vercel.
9. Aceite: subir 3 refs + Mata Grande pela UI; verificar `done` < 90 s,
   `pnpm eval:tier0` = 0, painéis + export PDF + telemetria.
10. Entregar URL + `APP_SECRET` à Stefany.
