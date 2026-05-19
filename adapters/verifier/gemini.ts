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
 * Mapeamento categoria do baseline → `statusVerificado` (SPEC §5) vive no
 * mapa CANÔNICO ÚNICO `domain/categoria-status.ts` (importado aqui e pelo
 * Tier 0 — é mapeamento de segurança, não pode ter cópia divergível).
 * `fonteVerificacao` = `entry.fonte` do baseline no hit.
 */

import { generateText, Output } from 'ai';
import { google } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import type { EditalExtraction } from '../../domain/schema.ts';
import type { NormaCache, NormaVerifierPort, NormaStatus } from '../../domain/ports.ts';

/**
 * Sink de custo de grounding (SPEC §11b — POR chamada, NÃO só agregado:
 * bomba de custo silenciosa se só agregado). Injetado pelo caller (worker)
 * que conhece o id de correlação; opcional (testes/baseline não passam).
 * O Verifier chama UMA vez por chamada de grounding REAL (após o LLM,
 * antes do cache) — não em hit de baseline nem cache.
 */
export type GroundingCustoSink = (uso: {
  lei: string;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
}) => void;
import { matchNorma } from '../../domain/norma-baseline.ts';
import type { BaselineEntry } from '../../domain/norma-baseline.ts';
import { categoriaParaStatus as categoriaParaStatusCanonico } from '../../domain/categoria-status.ts';
import { getConfig } from '../../infrastructure/config.ts';

type Lei = EditalExtraction['leisReferenciadas'][number];

/** Verdict do grounding (saída estruturada — substitui o regex do spike). */
const VerdictSchema = z.object({
  status: z.enum(['vigente', 'revogada', 'contestada', 'inexistente']),
  fonte: z.string(),
});

/**
 * Categoria curada do baseline → status verificado determinístico. Delega ao
 * mapa CANÔNICO ÚNICO em `domain/categoria-status.ts` (mapeamento de
 * segurança — eliminado o duplicado divergível). Categoria desconhecida →
 * `nao-verificado` (não inventar veredito; fallback do Verifier).
 */
function categoriaParaStatus(categoria: string): NormaStatus {
  return categoriaParaStatusCanonico(categoria) ?? 'nao-verificado';
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
  /**
   * @param onGroundingCusto sink OPCIONAL de custo por chamada de
   * grounding (§11b). O worker injeta um que grava telemetria
   * (não-bloqueante); testes injetam um spy; ausente = no-op.
   */
  constructor(
    private readonly cache: NormaCache,
    model?: LanguageModel,
    private readonly onGroundingCusto?: GroundingCustoSink
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

    const { experimental_output, usage } = await generateText({
      model: this.model,
      tools: { google_search: google.tools.googleSearch({}) },
      // Saída ESTRUTURADA (substitui generateText+regex do spike). No AI SDK
      // structured output coexiste com grounding via `output` + `tools`.
      experimental_output: Output.object({ schema: VerdictSchema }),
      prompt,
    });

    // SPEC §11b: custo de grounding logado POR CHAMADA (não só agregado —
    // a cauda municipal real aciona grounding pago; bomba silenciosa se
    // só agregado). Emitido AQUI, dentro do ramo que realmente chamou o
    // LLM (nunca em hit de baseline/cache). Sink é não-bloqueante.
    this.onGroundingCusto?.({
      lei: `${lei.numero}/${lei.ano}`,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      totalTokens: usage?.totalTokens,
    });

    return {
      status: experimental_output.status,
      fonte: experimental_output.fonte,
    };
  }
}
