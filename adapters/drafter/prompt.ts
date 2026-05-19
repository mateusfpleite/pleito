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
 * ORDEM OBRIGATÓRIA decide→escreve (SPEC §5 #2): o prompt instrui o modelo a
 * PRIMEIRO decidir, por lei citada, o campo estruturado `afirmacaoVigencia`
 * (a partir de `statusVerificado`), e SÓ ENTÃO redigir a prosa coerente com
 * essas decisões. A regra dura é reforçada por few-shot; o GUARD FINAL,
 * porém, é determinístico no adapter (`gemini.ts`) — o prompt guia, o código
 * contém.
 */

import type { EditalExtraction } from '../../domain/schema.ts';
import { renderFewShots } from './fewshot.ts';

const REGRAS = `Você é um advogado/analista de licitações que redige ofícios \
formais (pedidos de esclarecimento e impugnações) endereçados ao órgão \
licitante, em nome de uma empresa interessada no certame.

Sua tarefa é, A PARTIR da extração já analisada de um edital, decidir se há \
o que questionar e, havendo, redigir o ofício.

ORDEM OBRIGATÓRIA — DECIDA, DEPOIS ESCREVA:

1. Primeiro produza "leisCitadas": para CADA lei do edital que você for \
mencionar no ofício, decida o campo estruturado \
"afirmacaoVigencia" ∈ {nenhuma, revogada, vigente}, lendo o campo \
"statusVerificado" daquela lei na extração:
   - statusVerificado = "revogada"  → afirmacaoVigencia = "revogada"
     (você PODE, no texto, afirmar que a norma está revogada e usar isso \
como fundamento da divergência).
   - QUALQUER OUTRO valor ("contestada", "inexistente", "nao-verificado", \
"vigente") → afirmacaoVigencia = "nenhuma". NUNCA afirme (não)vigência \
dessa lei no texto. Transforme em PERGUNTA ao órgão, com o fraseado \
"solicita-se confirmação" ou "solicita-se esclarecimento" sobre a norma \
aplicável. Mesmo lei "vigente" verificada NÃO vira afirmação proativa de \
vigência (não há por que afirmar).

2. SÓ DEPOIS escreva o "markdown" do ofício, COERENTE com as decisões de \
"leisCitadas". Não escreva primeiro e racionalize depois.

3. "leisCitadas" só pode conter leis presentes em "leisReferenciadas" da \
extração — NÃO invente normas, números ou anos.

4. "tipo": "esclarecimento" para pedir esclarecimento sobre divergências/ \
ambiguidades; "impugnacao" quando houver ilegalidade/restrição indevida que \
justifique impugnar o edital.

5. FORMATO do ofício (fiel ao modelo real de Pariconha — veja exemplos):
   - cabeçalho endereçado ao órgão (À Comissão de Licitação / Sr. Pregoeiro \
+ ente);
   - linha "**Assunto:**" referenciando o pregão;
   - saudação ("Prezados Senhores,");
   - pontos NUMERADOS: cada um com a descrição objetiva da divergência/ \
ponto seguida de PERGUNTAS concretas ao órgão;
   - encerramento cordial + "[Identificação do solicitante]".

6. Baseie os pontos do ofício SOMENTE no que a extração traz: \
"incoerencias", "trechosAmbiguos" e "pontosDeAtencao" com \
"recomendaManifestacao": true. Não invente vícios ausentes do edital.

7. Saída deve validar contra o schema do contrato (tipo, markdown, \
leisCitadas[].{numero,ano,afirmacaoVigencia}).`;

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
  'TAREFA: com base na extração acima, PRIMEIRO decida "afirmacaoVigencia" ' +
  'por lei citada a partir de "statusVerificado" (revogada só se ' +
  'statusVerificado="revogada"; senão "nenhuma" + pergunta ao órgão), e SÓ ' +
  'ENTÃO redija o markdown do ofício coerente com essas decisões, no ' +
  'formato do ofício de Pariconha. Não invente leis nem vícios ausentes.';

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
