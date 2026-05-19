/**
 * Risk Analyst adapter — Gemini Flash via Vercel AI SDK (`generateObject`).
 *
 * Pipeline step 5 (SPEC §4): receives an `EditalExtraction` that has
 * ALREADY passed through the Norma Verifier
 * (`leisReferenciadas[].statusVerificado` filled) and whose
 * `pontosDeAtencao` arrives `[]` (placeholder from the Phase 10
 * recomposition). Produces and RETURNS the same `EditalExtraction` with
 * `pontosDeAtencao` filled — all other fields intact (not mutated).
 *
 * Consuming VERIFIED status: the adapter sends the whole extraction to the
 * model (includes `statusVerificado`); rule 5 of the SYSTEM prompt
 * instructs the model to reason about legal risk from that field, NEVER
 * from the extractor's raw `revogada` flag (which is a guess — SPEC §5).
 *
 * `generateObject` schema: ONLY what the Risk Analyst produces — the
 * `pontosDeAtencao` array (sliced from `EditalExtractionSchema.shape` to
 * inherit exactly the domain contract: categoria/severidade enums,
 * recomendaManifestacao boolean). Forcing the full schema would make the
 * model rewrite fields outside its role. The recomposition on return
 * reattaches the array to the input extraction and revalidates the whole
 * against `EditalExtractionSchema` (defense in depth — test (a)/(b)).
 *
 * `recomendaManifestacao` × severidade coherence: the plan makes it
 * explicit (prompt rule 4) and the adapter does NOT silently post-process
 * — it trusts the model guided by Stefany's real few-shots and only
 * REVALIDATES the format. Tests (c)/(d) prove the model's
 * severidade/categoria are preserved and that non-pontosDeAtencao fields
 * are not mutated.
 */

import { generateObject } from 'ai';
import { google } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { EditalExtractionSchema } from '../../domain/schema.ts';
import type { EditalExtraction } from '../../domain/schema.ts';
import type { RiskAnalystPort } from '../../domain/ports.ts';
import { getConfig } from '../../infrastructure/config.ts';
import { montarPrompt, SYSTEM_PROMPT } from './prompt.ts';

/**
 * Schema for ONLY what the Risk Analyst produces, derived from the domain
 * `shape` (single source of truth — `categoria`/`severidade` enums and
 * `recomendaManifestacao` boolean come from `EditalExtractionSchema`).
 * Wrapped in an object because `generateObject` requires a top-level object.
 */
const PontosDeAtencaoSchema = z.object({
  pontosDeAtencao: EditalExtractionSchema.shape.pontosDeAtencao,
});

export class GeminiRiskAnalyst implements RiskAnalystPort {
  private readonly model: LanguageModel;

  /**
   * @param model injectable LanguageModel (testability — tests pass a
   * fake; production uses `google(config.EXTRACTOR_MODEL)`). Default
   * resolved lazily so tests that inject do not require an env/API key.
   */
  constructor(model?: LanguageModel) {
    this.model = model ?? google(getConfig().EXTRACTOR_MODEL);
  }

  async analisar(e: EditalExtraction): Promise<EditalExtraction> {
    const { object } = await generateObject({
      model: this.model,
      schema: PontosDeAtencaoSchema,
      system: SYSTEM_PROMPT,
      prompt: montarPrompt(e),
    });

    // `generateObject` already validates the array against
    // PontosDeAtencaoSchema (test (b): categoria outside the enum →
    // throw). Recompose the input extraction with the filled array — ALL
    // other fields preserved, without mutating the input object — and
    // revalidate the whole (defense in depth).
    return EditalExtractionSchema.parse({
      ...e,
      pontosDeAtencao: object.pontosDeAtencao,
    });
  }
}
