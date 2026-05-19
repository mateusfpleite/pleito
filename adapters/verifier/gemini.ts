/**
 * Norma Verifier adapter — 3 layers (SPEC §5, defense in depth).
 *
 * Rewrite of the POC I/O (`src/spike-verifier.ts` was
 * `main()`+`process.exit` with `generateText`+JSON-extraction regex).
 * Here:
 *  - hexagonal contract `verificar(e: EditalExtraction)`
 *    (NormaVerifierPort);
 *  - `matchNorma` precedence (curated baseline) BEFORE any grounding —
 *    hit = deterministic, zero cost, no LLM;
 *  - miss → web grounding (Gemini + Google Search) with STRUCTURED OUTPUT
 *    (`Output.object` + verdict schema) instead of the spike's
 *    `generateText`+regex. `generateObject` does not accept `tools` in
 *    the AI SDK; the supported form of "structured output WITH grounding"
 *    is `generateText({ tools, output })` — the plan's intent (no regex
 *    on prose, validated schema) is met;
 *  - `NormaCache` queried before grounding and written after (stable key
 *    `numero|ano|escopo`), avoiding repeated cost on the tail.
 *
 * Documented DECISION (plan §5, ambiguous point): the Verifier is called
 * CONDITIONALLY by the workflow (Gate A, Phase 10). The adapter itself,
 * however, processes ALL incoming `leisReferenciadas`: it applies the
 * matcher to all and only grounds those that MISSED the baseline (it does
 * not filter by the extractor's `revogada` — Gate A already decided to
 * fire; refiltering here would reintroduce the false-negative that SPEC
 * §5 closes). Laws with `numero:null` (e.g. Constituição) match neither
 * the baseline nor have a stable cache/grounding key → they stay
 * `nao-verificado` (tail → human review).
 *
 * Mapping baseline categoria → `statusVerificado` (SPEC §5) lives in the
 * SINGLE CANONICAL map `domain/categoria-status.ts` (imported here and by
 * Tier 0 — it is a safety mapping, it cannot have a divergeable copy).
 * `fonteVerificacao` = baseline `entry.fonte` on a hit.
 */

import { generateText, Output } from 'ai';
import { google } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import type { EditalExtraction } from '../../domain/schema.ts';
import type { NormaCache, NormaVerifierPort, NormaStatus } from '../../domain/ports.ts';

/**
 * Grounding cost sink (SPEC §11b — PER call, NOT only aggregated: a
 * silent cost bomb if only aggregated). Injected by the caller (worker)
 * that knows the correlation id; optional (tests/baseline do not pass
 * it). The Verifier calls it ONCE per REAL grounding call (after the LLM,
 * before the cache) — not on a baseline hit nor a cache hit.
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

/** Grounding verdict (structured output — replaces the spike's regex). */
const VerdictSchema = z.object({
  status: z.enum(['vigente', 'revogada', 'contestada', 'inexistente']),
  fonte: z.string(),
});

/**
 * Curated baseline categoria → deterministic verified status. Delegates
 * to the SINGLE CANONICAL map in `domain/categoria-status.ts` (safety
 * mapping — the divergeable duplicate was eliminated). Unknown categoria
 * → `nao-verificado` (do not invent a verdict; Verifier fallback).
 */
function categoriaParaStatus(categoria: string): NormaStatus {
  return categoriaParaStatusCanonico(categoria) ?? 'nao-verificado';
}

/** Stable cache key (independent of the extractor's spacing/scope). */
function chaveCache(lei: Lei): string {
  return `${lei.numero}|${lei.ano}|${lei.escopo}`;
}

export class GeminiNormaVerifier implements NormaVerifierPort {
  private readonly model: LanguageModel;

  /**
   * @param cache injectable NormaCache (in-memory fake in tests; real
   * Supabase adapter in Phase 11).
   * @param model injectable LanguageModel (tests pass a fake; production
   * uses `google(config.EXTRACTOR_MODEL)` resolved lazily — does not
   * require an env/API key in tests that inject, and on baseline cases it
   * is not even touched).
   */
  /**
   * @param onGroundingCusto OPTIONAL per-grounding-call cost sink (§11b).
   * The worker injects one that writes telemetry (non-blocking); tests
   * inject a spy; absent = no-op.
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
    // Layer 1 — baseline (precedence, zero cost, NO grounding).
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

    // Laws without a number (e.g. Constituição) have no stable cache key
    // nor grounding target — they stay unverified (tail → review).
    if (lei.numero == null || lei.ano == null) {
      return { ...lei, statusVerificado: 'nao-verificado', fonteVerificacao: null };
    }

    // Layer 2 — cache before grounding (zero cost on reuse).
    const chave = chaveCache(lei);
    const cached = await this.cache.obter(chave);
    if (cached) {
      return {
        ...lei,
        statusVerificado: cached.status,
        fonteVerificacao: cached.fonte,
      };
    }

    // Layer 2 (cont.) — web grounding only on the tail outside the baseline.
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
      // STRUCTURED output (replaces the spike's generateText+regex). In
      // the AI SDK structured output coexists with grounding via `output`
      // + `tools`.
      experimental_output: Output.object({ schema: VerdictSchema }),
      prompt,
    });

    // SPEC §11b: grounding cost logged PER CALL (not only aggregated —
    // the real municipal tail triggers paid grounding; silent bomb if
    // only aggregated). Emitted HERE, inside the branch that actually
    // called the LLM (never on a baseline/cache hit). The sink is
    // non-blocking.
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
