# Pleito — Proveniência & Decisões

> Log **append-only** da trilha de evidências e decisões. Estado atual do produto em `SPEC.md`. Aqui fica o *como chegamos lá* e *com base em quê* — material de rigor para o pitch Amber e de continuidade.

**Iniciado:** 2026-05-13 · **Última entrada:** 2026-05-15

---

## 1. Origem (2026-05-13)

Objetivo: demonstrar engenharia agêntica para candidatura na Amber AI (agentic OS para marcas com supply chain físico; stack Next.js+Supabase+Prisma+Mastra/LangChain). Ideia-semente: fluxo agêntico sobre licitações públicas (PNCP). Pivô para dor real via Stefany (irmã), estruturando a área de licitações da Zelo (serviços funerários, ~todos os municípios do Brasil).

## 2. Descoberta do problema

Método: pergunta aberta sobre dor, sem apresentar soluções. Áudios da Stefany (trechos canônicos):

> "não sei se tem como automatizar não (...) tem que ler. A lei tem muitas brechas (...) cada município tem uma lei (...) a Zelo tem unidade em quase todos os municípios"

> "minha dificuldade é questão de lei (...) não tem como eu gravar a lei de cada município (...) [chefe ex-dev] a dificuldade maior seria um software de ajuda financeira (...) processo licitatório não é volume tão grande"

**Reframe:** não automatizar a leitura (insubstituível) — fazer o trabalho *em volta* dela. Dor financeira do chefe → V4. **Princípio metodológico:** especialista de domínio não-técnico → extrair dor, nunca apresentar opções de solução.

## 3. Editais de referência

Coletados: Dom Basílio/BA PE 90065/2025 (baseline, divergência de valor capa×TR), Jaborandi/BA PE 008/2025 (**capa mentirosa** "caminhões pipa", lei revogada anacrônica), Niterói/RJ ION PE 90005/2025 (regime 13.303, valor sigiloso, anexo ausente). Enviados pela Stefany: Mata Grande/AL PE 016/2026 (edital + análise dela) e ofício de esclarecimento de Pariconha/AL (formato real).

## 4. Evolução do schema

v0 (hipótese) → v1 (Dom Basílio+Jaborandi: objetoCapa/Corpo, procedência de valor, itens, incoerencias×trechosAmbiguos, habilitação estruturada) → v2 (Niterói: regimeJuridico top-level, anexos.presenteNoArquivo, tipoNorma, regimeExecucao) → v3 (Mata Grande: plataforma, subcontratacao, intervaloMinimoLances, prazoRecursos, informacoesViabilidade, **pontosDeAtencao[]**).

## 5. Seleção de modelo

Benchmark (mai/2026): Gemini 2.5 Flash aprovado (1M context, MMLU-Pro 80.9, $0.30/$2.50). Flash Lite reprovado (bugs structured output). GPT-5.4 mini ok mas 2.5x mais caro. Haiku 4.5 fraco p/ extractor (200k), forte p/ tool use. DeepSeek reprovado (PT-BR jurídico não validado). POC contra os 3 editais: 100% schema válido, 71s médio, $0.056/edital, pegou capa mentirosa + lei revogada + sigiloso + anexo ausente.

## 6. Validação da premissa de heterogeneidade

Pesquisa em 15 municípios: lei funerária municipal existe em 14/15 (competência constitucional, art. 30 V CF + ADI 1.221/RJ); concessões variam de fato (STF ADPF 756/2021 validou rodízio de Curitiba); **exigências sanitárias mais federais do que Stefany supôs** (RDC ANVISA 33/2011, 662/2022, CONAMA 335/2003). Reframe: o moat não é a lei funerária isolada (conteúdo repetitivo) — é o **stack regulatório composto** por município.

## 7. Cenário competitivo

~20 players brasileiros, todos horizontais, IA fina sobre LLM, pricing R$ 40-2.000/mês. Software funerário (Dream/PROGEM/Unymos): só operacional. Internacional (Govini/GovDash): maduro, horizontal. **White space:** ninguém cura stack regulatório municipal por setor. TAM honesto: ~R$ 7M ARR nicho funerário; R$ 50-100M agregado B2G municipal.

## 8. Rodada de validação com Stefany (2026-05-14)

**Orgânico (WhatsApp, alta confiança):** "elaborasse um esclarecimento para as divergências"; "impugnasse se fosse o caso"; "colocar os pontos de risco". Artefatos reais: análise Mata Grande (formato dela, seção "Pontos de Atenção"), ofício Pariconha.

**Crítico:** ela usou ChatGPT para expandir a resposta ("joguei no chat aqui pra ele ajudar"). Decomposição por confiança:
- **Tier 1 (canônico):** esclarecimento, impugnação, pontos de risco, campos do formato dela.
- **Tier 2 (provável, confirmar):** análise operacional funerária (24h, plantões, base local, cobertura rural), inexequibilidade, classificação fornecimento×serviço, indícios de direcionamento.
- **Tier 3 (framing LLM, não construir):** "mapa de riscos" como dashboard com taxonomias formais; recurso/diligência não solicitados organicamente.

**Leitura de engajamento:** recorrer ao ChatGPT sinaliza empolgação não-alta. Decisão: não pedir mais feedback (geraria Tier 3); liderar por produto — entregar algo funcional, uso real é o sinal verdadeiro. Plataforma: **app web** (ela é assistente, não dev — CLI descartada).

## 9. Decisão de arquitetura

Enricher enumerativo de leis **removido do V0** (Stefany não pediu; análise dela não tem resumo de leis). Pipeline vira 3 agentes em pipeline condicional (Extractor → Risk Analyst → Drafter). Tool repropositada: de enumerar leis → fundamentar argumentos do ofício. Posterior reversão parcial (§12) reintroduziu verificação de forma cirúrgica.

## 10. Estudo de base rate (2026-05-15)

24 editais, 13 UFs, schema focado. **38% citam ≥1 norma revogada; 25% caso não-notório; 0 municipal revogada** (refuta hipótese de alucinação municipal — prefeitura cita lei vigente). O perigo real: norma federal infralegal antiga de copy-paste (IN SEGES 05/2017 4×, IN SLTI 01/2010 3×, etc.). Verificação de acurácia (7 casos com gabarito manual): **Gemini puro 4/7 errado, todos falso-positivo de revogação, conf=alta**. Conclusão: comum e inseguro → verificação volta ao V0, mas cirúrgica (só o subconjunto flagrado, federal verificável — não a cauda municipal).

## 11. Spike Norma Verifier v1 (2026-05-15)

Gemini 2.5 Flash + Google Search grounding vs 7 casos: 86% status, 100% escopo, pegou os 2 piores (Lei 9.704 inexistente, Lei 6.544 escopo estadual). 1 "erro perigoso": IN SEGES 05/2017 (disse vigente; gabarito dizia revogada).

## 12. Horda de gap scan + correção crítica (2026-05-15)

4 agentes paralelos (verificar pendentes+auditar; gap scan pregão N/NE/CO; concessão S/SE; credenciamento/leilão).

**Correção crítica:** o gabarito da IN SEGES 05/2017 estava **errado** — herdado da 1ª verificação manual (que se auto-ressalvou "confirmar item 3"). IN 98/2022 NÃO revogou expressamente a 05/2017; vigente, recepção supletiva sob 14.133, alcance controverso. Logo o "erro perigoso" do spike v1 era o **modelo certo, gabarito errado**. Lição: até verificação manual diligente erra na 1ª passada — valida a tabela curada com proveniência e a contenção (status infralegal recepcionado = zona-cinzenta, nunca afirmar binário).

**Gaps confirmados** (todos VIGENTES, entram como âncora anti-falso-positivo): regime 14.133 (Dec 11.462/23 SRP, Dec 11.246/22, Dec 11.878/24, Lei 12.846/13, LGPD, LC 147/14, Lei 12.440/11); concessão (Lei 8.987/95, 9.074/95, 11.079/04); assistência social (LOAS 8.742/93, Lei 12.435/11). Fantasma: "Lei 13.144/2021" (como a 9.704). Resultado: `data/norma-baseline.json` v0.2 — 25 entradas sourced, 5 categorias.

## 13. Spike Norma Verifier v2 (2026-05-15)

Com baseline injetada + gabarito corrigido: **7/7 status, 7/7 escopo, 7/7 via baseline (zero grounding pago), 0 erro perigoso**. IN 05/2017 resolve como `incerto` (zona-cinzenta → vira pergunta). Gate 1 fechado. Gate 2 (deploy/auth): decidido Vercel + auth mínima. Ambos pré-build limpos. Custo do Verifier ≈ zero no conjunto recorrente.

## 14. Convenção de prompt (2026-05-15)

Decidido template padrão dos 4 agentes: System (papel→regras→few-shot, cacheável) + User (contexto grande→tarefa→contrato de saída, recência long-context). Gold examples = artefatos reais validados (3 editais, análise Mata Grande, ofício Pariconha, baseline por categoria), versionados como assets.

## 15. Decisões arquiteturais — log

| Data | Decisão | Justificativa |
|---|---|---|
| 05-13 | Foco compliance (não financeiro) | MVP enxuto, tese vertical AI |
| 05-14 | Gemini 2.5 Flash | 4 critérios bloqueantes; $0.06/edital |
| 05-14 | AI SDK puro, sem Mastra V0 | YAGNI até V2 |
| 05-14 | Hexagonal nos ports | troca de provider 1-liner |
| 05-14 | Reframe "stack regulatório composto" | validação empírica 15 municípios |
| 05-14 | Nome "Pleito" | desacoplar do cliente-âncora |
| 05-15 | Remover enricher enumerativo do V0 | Tier 1: Stefany não pediu |
| 05-15 | Verifier 3-camadas (baseline→grounding→contenção) | base rate: modelo 57% acurácia, inseguro |
| 05-15 | `norma-baseline.json` como ativo curado | moat materializado no V0 |
| 05-15 | Dashboard single-edital + PDF on-demand | UX de triagem + segurança (review antes de export) |
| 05-15 | Persistir conteúdo, nunca PDF | derivado regenerável grátis |
| 05-15 | Deploy Vercel + auth mínima | Stefany acessa por URL |
| 05-15 | Docs por cadência (SPEC vivo / PROVENANCE append-only / pitch) | cadências de atualização distintas |

## 16. Lições metodológicas (transferíveis)

1. Validar premissas empiricamente antes de construir — inclusive o próprio gabarito (IN 05/2017).
2. Especialista de domínio + LLM = dor real + framing decorativo; decompor por confiança (orgânico × artefato × LLM-expandido).
3. Engajamento morno → liderar por produto, não pedir mais feedback.
4. Schema e baseline evoluem contra editais reais, não hipótese.
5. Defense in depth: nenhuma camada de segurança sozinha basta; verificação difícil até manualmente → curadoria com proveniência + contenção.
