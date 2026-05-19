/**
 * Extractor adapter — Gemini Flash via Vercel AI SDK (`generateObject`).
 *
 * Rewrite of the POC I/O (`src/extract.ts` was `main()` + `process.exit`,
 * not a module). The validated LOGIC (prompt/instructions) is reused via
 * `./prompt.ts`; here only the hexagonal boundary.
 *
 * CRITICAL CARRY-FORWARD (Phase 1): the schema passed to `generateObject`
 * is `ExtractorOutputSchema` — `EditalExtractionSchema.omit({
 * pontosDeAtencao })`. `pontosDeAtencao` belongs to the Risk Analyst
 * (pipeline step 5, SPEC §4); using the full schema would force Gemini to
 * fabricate it. `application/` recomposes the complete `EditalExtraction`
 * with `pontosDeAtencao: []` (explicit placeholder) before the Risk Analyst
 * fills it. The `ExtractorPort` returns `ExtractorOutput` (without
 * pontosDeAtencao), not the `EditalExtraction` yet.
 */

import { generateObject } from 'ai';
import { google } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { ExtractorOutputSchema } from '../../domain/schema.ts';
import type { ExtractorOutput, FonteMeta } from '../../domain/schema.ts';
import type { ExtractorPort } from '../../domain/ports.ts';
import { getConfig } from '../../infrastructure/config.ts';
import { montarPrompt, SYSTEM_PROMPT } from './prompt.ts';

export class GeminiExtractor implements ExtractorPort {
  private readonly model: LanguageModel;

  /**
   * @param model injectable LanguageModel (testability — tests pass a
   * fake; production uses `google(config.EXTRACTOR_MODEL)`). Default
   * resolved lazily so tests that inject do not require an env/API key.
   */
  constructor(model?: LanguageModel) {
    this.model = model ?? google(getConfig().EXTRACTOR_MODEL);
  }

  async extrair(
    texto: string,
    _fonte: FonteMeta
  ): Promise<ExtractorOutput> {
    const { object } = await generateObject({
      model: this.model,
      schema: ExtractorOutputSchema,
      system: SYSTEM_PROMPT,
      prompt: montarPrompt(texto),
    });
    // `generateObject` already validates against ExtractorOutputSchema and
    // throws if the model returns an object outside the schema (test (c)
    // covers this). The explicit parse reasserts the contract and applies
    // defaults (statusVerificado).
    return ExtractorOutputSchema.parse(object);
  }
}
