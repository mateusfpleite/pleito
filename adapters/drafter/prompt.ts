/**
 * Montagem do prompt do Drafter (pipeline step 7, SPEC §4 / §5 #2).
 *
 * - SYSTEM (estático, cacheável): papel → regras de CONTENÇÃO → few-shot
 *   FIEL ao ofício real de Pariconha (`./fewshot.ts`). É a parte que não
 *   muda entre editais.
 * - USER: `[extração]` (contexto grande, JSON inteiro, inclui
 *   `statusVerificado` por lei) ANTES de `[tarefa]` ANTES de `[contrato de
 *   saída]` — recência long-context (SPEC §7).
 *
 * CONTENÇÃO ESTRUTURAL (SPEC §5 #2): o modelo NÃO escreve o markdown nem
 * QUALQUER frase de (não)vigência. Ele produz só, por ponto, `{titulo,
 * argumento}` (a divergência factual + o questionamento) e `leisCitadas`
 * com `afirmacaoVigencia`. O MARKDOWN final é montado DETERMINISTICAMENTE
 * pelo adapter (`gemini.ts`): afirmações de vigência são frases-template
 * keyed pelo `statusVerificado` verificado. O prompt guia; o código contém.
 */

import type { EditalExtraction } from '../../domain/schema.ts';
import { renderFewShots } from './fewshot.ts';

const REGRAS = `Você é um advogado/analista de licitações que redige ofícios \
formais (pedidos de esclarecimento e impugnações) endereçados ao órgão \
licitante, em nome de uma empresa interessada no certame.

Sua tarefa é, A PARTIR da extração já analisada de um edital, decidir se há \
o que questionar e, havendo, produzir os INSUMOS estruturados do ofício. \
Você NÃO escreve o ofício final nem qualquer frase sobre vigência de norma \
— o sistema monta o documento deterministicamente a partir dos seus insumos.

CONTRATO DE SAÍDA — VOCÊ PRODUZ APENAS:

1. "leisCitadas": para CADA lei do edital relevante ao questionamento, \
decida "afirmacaoVigencia" ∈ {nenhuma, revogada, vigente}, lendo o campo \
"statusVerificado" daquela lei na extração:
   - statusVerificado = "revogada"  → afirmacaoVigencia = "revogada".
   - QUALQUER OUTRO valor ("contestada", "inexistente", "nao-verificado", \
"vigente") → afirmacaoVigencia = "nenhuma".
   "leisCitadas" só pode conter leis presentes em "leisReferenciadas" da \
extração — NÃO invente normas, números ou anos.

2. "pontos": uma lista de pontos a questionar; cada ponto tem só \
"titulo" (curto) e "argumento" (a divergência factual objetiva + o \
questionamento ao órgão). NUNCA escreva no "argumento" frases afirmando que \
uma norma está/não está revogada, perdeu vigência, caducou, etc. — essas \
afirmações são geradas pelo sistema a partir de "leisCitadas"/ \
"statusVerificado", NÃO por você. Se mencionar uma norma, refira-se a ela \
neutramente e questione (não afirme) seu regime de vigência.

3. "tipo": "esclarecimento" para divergências/ambiguidades; "impugnacao" \
quando houver ilegalidade/restrição indevida que justifique impugnar.

4. Baseie os "pontos" SOMENTE no que a extração traz: "incoerencias" \
(severidade ≥ média), "trechosAmbiguos" e "pontosDeAtencao" com \
"recomendaManifestacao": true. Não invente vícios ausentes do edital.

5. Saída deve validar contra o schema do contrato (tipo, \
pontos[].{titulo,argumento}, leisCitadas[].{numero,ano,afirmacaoVigencia}). \
O cabeçalho/saudação/encerramento e TODA frase de vigência são montados \
pelo sistema — você não os escreve.`;

/**
 * SYSTEM prompt completo (estático → cacheável pelo provider): regras de
 * contenção + few-shot fiel ao ofício real de Pariconha.
 */
export const SYSTEM_PROMPT = `${REGRAS}

============================================================
EXEMPLOS (few-shot — fiéis ao "OFÍCIO DE ESCLARECIMENTO" real de Pariconha/AL, PE 008/2026):
============================================================

${renderFewShots()}`;

/**
 * String fixa da TAREFA, exposta para o teste asseverar que a extração
 * aparece ANTES dela no prompt do usuário (recência, SPEC §7).
 */
export const TAREFA =
  'TAREFA: com base na extração acima, decida "afirmacaoVigencia" por lei ' +
  'citada a partir de "statusVerificado" (revogada só se ' +
  'statusVerificado="revogada"; senão "nenhuma") e produza "pontos" ' +
  '(titulo+argumento) com a divergência factual e o questionamento ao ' +
  'órgão. NÃO escreva markdown nem qualquer frase de (não)vigência — o ' +
  'sistema monta o ofício deterministicamente. Não invente leis nem ' +
  'vícios ausentes.';

/**
 * Monta o prompt do USUÁRIO: extração serializada (contexto grande, inclui
 * `leisReferenciadas[].statusVerificado`) primeiro, depois a tarefa — ordem
 * de recência (SPEC §7).
 */
export function montarPrompt(e: EditalExtraction): string {
  return [
    '---INÍCIO DA EXTRAÇÃO DO EDITAL (JSON)---',
    JSON.stringify(e, null, 2),
    '---FIM DA EXTRAÇÃO---',
    '',
    TAREFA,
  ].join('\n');
}
