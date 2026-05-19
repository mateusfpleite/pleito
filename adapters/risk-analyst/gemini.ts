/**
 * Risk Analyst adapter — Gemini Flash via Vercel AI SDK (`generateObject`).
 *
 * Pipeline step 5 (SPEC §4): recebe um `EditalExtraction` que JÁ passou pelo
 * Norma Verifier (`leisReferenciadas[].statusVerificado` preenchido) e cujo
 * `pontosDeAtencao` chega `[]` (placeholder da recomposição da Phase 10).
 * Produz e RETORNA o mesmo `EditalExtraction` com `pontosDeAtencao`
 * preenchido — todos os demais campos intactos (não mutados).
 *
 * Consumo de status VERIFICADO: o adapter envia a extração inteira ao modelo
 * (inclui `statusVerificado`); a regra 5 do SYSTEM prompt instrui o modelo a
 * raciocinar sobre risco jurídico a partir desse campo, NUNCA da flag crua
 * `revogada` do extractor (que é palpite — SPEC §5).
 *
 * Schema do `generateObject`: SÓ o que o Risk Analyst produz — o array
 * `pontosDeAtencao` (recortado de `EditalExtractionSchema.shape` para herdar
 * exatamente o contrato do domínio: categoria/severidade enums,
 * recomendaManifestacao boolean). Forçar o schema cheio faria o modelo
 * reescrever campos que não são seu papel. A recomposição no retorno reanexa
 * o array à extração de entrada e revalida o todo contra
 * `EditalExtractionSchema` (defense in depth — teste (a)/(b)).
 *
 * Coerência `recomendaManifestacao` × severidade: o plano deixa explícito
 * (regra 4 do prompt) e o adapter NÃO pós-processa silenciosamente — confia
 * no modelo guiado pelos few-shot reais da Stefany e apenas REVALIDA o
 * formato. Os testes (c)/(d) provam que severidade/categoria do modelo são
 * preservadas e que campos não-pontosDeAtencao não são mutados.
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
 * Schema SÓ do que o Risk Analyst produz, derivado do `shape` do domínio
 * (single source of truth — `categoria`/`severidade` enums e
 * `recomendaManifestacao` boolean vêm de `EditalExtractionSchema`). Embrulhado
 * num objeto porque `generateObject` exige objeto no topo.
 */
const PontosDeAtencaoSchema = z.object({
  pontosDeAtencao: EditalExtractionSchema.shape.pontosDeAtencao,
});

export class GeminiRiskAnalyst implements RiskAnalystPort {
  private readonly model: LanguageModel;

  /**
   * @param model LanguageModel injetável (testabilidade — testes passam um
   * fake; produção usa `google(config.EXTRACTOR_MODEL)`). Default resolvido
   * preguiçosamente para não exigir env/API key nos testes que injetam.
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

    // `generateObject` já valida o array contra PontosDeAtencaoSchema (teste
    // (b): categoria fora do enum → throw). Recompõe a extração de entrada
    // com o array preenchido — TODOS os demais campos preservados, sem mutar
    // o objeto de entrada — e revalida o todo (defense in depth).
    return EditalExtractionSchema.parse({
      ...e,
      pontosDeAtencao: object.pontosDeAtencao,
    });
  }
}
