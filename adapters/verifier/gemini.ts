/**
 * Norma Verifier adapter — 3 camadas (SPEC §5, defense in depth).
 *
 * Reescrita do I/O do POC (`src/spike-verifier.ts` era `main()`+`process.exit`
 * com `generateText`+regex de extração de JSON). Aqui:
 *  - contrato hexagonal `verificar(e: EditalExtraction)` (NormaVerifierPort);
 *  - precedência `matchNorma` (baseline curado) ANTES de qualquer grounding —
 *    hit = determinístico, custo zero, sem LLM;
 *  - miss → web grounding (Gemini + Google Search) com SAÍDA ESTRUTURADA
 *    (`Output.object` + schema de verdict) em vez do `generateText`+regex do
 *    spike. `generateObject` não aceita `tools` no AI SDK; a forma suportada
 *    de "structured output COM grounding" é `generateText({ tools, output })`
 *    — a intenção do plano (sem regex em prosa, schema validado) é atendida;
 *  - `NormaCache` consultado antes do grounding e gravado depois (chave
 *    estável `numero|ano|escopo`), evitando custo repetido na cauda.
 *
 * DECISÃO documentada (plano §5, ponto ambíguo): o Verifier é chamado
 * CONDICIONALMENTE pelo workflow (Gate A, Phase 10). O próprio adapter,
 * porém, processa TODAS as `leisReferenciadas` que chegam: aplica o matcher
 * em todas e só faz grounding nas que deram MISS na baseline (não filtra por
 * `revogada` do extractor — o Gate A já decidiu disparar; refiltrar aqui
 * reintroduziria o falso-negativo que o SPEC §5 fecha). Leis com
 * `numero:null` (ex.: Constituição) não casam baseline nem têm chave de
 * cache/grounding estável → ficam `nao-verificado` (cauda → revisão humana).
 *
 * Mapeamento categoria do baseline → `statusVerificado` (SPEC §5):
 *   revogada-notoria | revogada-confirmada → 'revogada'
 *   zona-cinzenta                          → 'contestada'
 *   citacao-suspeita                       → 'inexistente'
 *   vigente-ancora                         → 'vigente'
 * `fonteVerificacao` = `entry.fonte` do baseline no hit.
 */

import { generateText, Output } from 'ai';
import { google } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import type { EditalExtraction } from '../../domain/schema.ts';
import type { NormaCache, NormaVerifierPort, NormaStatus } from '../../domain/ports.ts';
import { matchNorma } from '../../domain/norma-baseline.ts';
import type { BaselineEntry } from '../../domain/norma-baseline.ts';
import { getConfig } from '../../infrastructure/config.ts';

type Lei = EditalExtraction['leisReferenciadas'][number];

/** Verdict do grounding (saída estruturada — substitui o regex do spike). */
const VerdictSchema = z.object({
  status: z.enum(['vigente', 'revogada', 'contestada', 'inexistente']),
  fonte: z.string(),
});

/** Categoria curada do baseline → status verificado determinístico. */
function categoriaParaStatus(categoria: string): NormaStatus {
  switch (categoria) {
    case 'revogada-notoria':
    case 'revogada-confirmada':
      return 'revogada';
    case 'zona-cinzenta':
      return 'contestada';
    case 'citacao-suspeita':
      return 'inexistente';
    case 'vigente-ancora':
      return 'vigente';
    default:
      // Categoria nova/desconhecida no baseline: não inventar veredito.
      return 'nao-verificado';
  }
}

/** Chave de cache estável (independe de espaçamento/escopo do extractor). */
function chaveCache(lei: Lei): string {
  return `${lei.numero}|${lei.ano}|${lei.escopo}`;
}

export class GeminiNormaVerifier implements NormaVerifierPort {
  private readonly model: LanguageModel;

  /**
   * @param cache NormaCache injetável (fake in-memory nos testes; adapter
   * Supabase real na Phase 11).
   * @param model LanguageModel injetável (testes passam fake; produção usa
   * `google(config.EXTRACTOR_MODEL)` resolvido preguiçosamente — não exige
   * env/API key nos testes que injetam, e nos casos baseline nem é tocado).
   */
  constructor(
    private readonly cache: NormaCache,
    model?: LanguageModel
  ) {
    this.model = model ?? google(getConfig().EXTRACTOR_MODEL);
  }

  async verificar(e: EditalExtraction): Promise<EditalExtraction> {
    const leisReferenciadas: Lei[] = [];
    for (const lei of e.leisReferenciadas) {
      leisReferenciadas.push(await this.verificarLei(lei));
    }
    return { ...e, leisReferenciadas };
  }

  private async verificarLei(lei: Lei): Promise<Lei> {
    // Camada 1 — baseline (precedência, custo zero, SEM grounding).
    const hit = matchNorma({
      numero: lei.numero,
      ano: lei.ano,
      escopo: lei.escopo,
      tipoNorma: lei.tipoNorma,
    });
    if (hit) {
      const entry = hit.entry as BaselineEntry & { fonte?: string };
      return {
        ...lei,
        statusVerificado: categoriaParaStatus(hit.categoria),
        fonteVerificacao: entry.fonte ?? null,
      };
    }

    // Leis sem número (ex.: Constituição) não têm chave estável p/ cache
    // nem alvo de grounding — ficam não-verificadas (cauda → revisão).
    if (lei.numero == null || lei.ano == null) {
      return { ...lei, statusVerificado: 'nao-verificado', fonteVerificacao: null };
    }

    // Camada 2 — cache antes do grounding (custo zero em reuso).
    const chave = chaveCache(lei);
    const cached = await this.cache.obter(chave);
    if (cached) {
      return {
        ...lei,
        statusVerificado: cached.status,
        fonteVerificacao: cached.fonte,
      };
    }

    // Camada 2 (cont.) — web grounding só na cauda fora da baseline.
    const verdict = await this.grounding(lei);
    await this.cache.gravar({
      chave,
      status: verdict.status,
      fonte: verdict.fonte,
    });
    return {
      ...lei,
      statusVerificado: verdict.status,
      fonteVerificacao: verdict.fonte,
    };
  }

  private async grounding(
    lei: Lei
  ): Promise<{ status: NormaStatus; fonte: string }> {
    const prompt = `Você verifica o status de vigência de normas jurídicas \
brasileiras de licitação usando busca web em fontes autoritativas (planalto.\
gov.br, gov.br, in.gov.br, lexml, assembleias estaduais).

NORMA A VERIFICAR:
${lei.descricao}
Tipo: ${lei.tipoNorma} · número: ${lei.numero}/${lei.ano} · escopo alegado \
no edital: ${lei.escopo}
Contexto no edital: ${lei.contextoNoEdital}

Determine o status:
- "vigente": em vigor;
- "revogada": revogada expressa ou tacitamente (cite a sucessora na fonte);
- "contestada": status juridicamente disputado / recepção supletiva controversa;
- "inexistente": a norma citada não existe ou tem escopo/objeto trocado.
Use "fonte" = URL autoritativa que sustenta o veredito.`;

    const { experimental_output } = await generateText({
      model: this.model,
      tools: { google_search: google.tools.googleSearch({}) },
      // Saída ESTRUTURADA (substitui generateText+regex do spike). No AI SDK
      // structured output coexiste com grounding via `output` + `tools`.
      experimental_output: Output.object({ schema: VerdictSchema }),
      prompt,
    });

    return {
      status: experimental_output.status,
      fonte: experimental_output.fonte,
    };
  }
}
