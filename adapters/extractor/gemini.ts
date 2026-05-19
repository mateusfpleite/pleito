/**
 * Extractor adapter — Gemini Flash via Vercel AI SDK (`generateObject`).
 *
 * Reescrita do I/O do POC (`src/extract.ts` era `main()` + `process.exit`,
 * não um módulo). A LÓGICA validada (prompt/instruções) é reaproveitada via
 * `./prompt.ts`; aqui só o boundary hexagonal.
 *
 * CARRY-FORWARD CRÍTICO (Phase 1): o schema passado ao `generateObject` é
 * `ExtractorOutputSchema` — `EditalExtractionSchema.omit({ pontosDeAtencao
 * })`. `pontosDeAtencao` é do Risk Analyst (pipeline step 5, SPEC §4); usar
 * o schema cheio forçaria o Gemini a fabricá-lo. O `application/` recompõe
 * o `EditalExtraction` completo com `pontosDeAtencao: []` (placeholder
 * explícito) antes do Risk Analyst preenchê-lo. O `ExtractorPort` retorna
 * `ExtractorOutput` (sem pontosDeAtencao), não o `EditalExtraction` ainda.
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
   * @param model LanguageModel injetável (testabilidade — testes passam um
   * fake; produção usa `google(config.EXTRACTOR_MODEL)`). Default resolvido
   * preguiçosamente para não exigir env/API key nos testes que injetam.
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
    // `generateObject` já valida contra ExtractorOutputSchema e lança se o
    // modelo devolver objeto fora do schema (teste (c) cobre isso). O parse
    // explícito reafirma o contrato e aplica defaults (statusVerificado).
    return ExtractorOutputSchema.parse(object);
  }
}
