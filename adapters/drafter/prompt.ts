/**
 * Montagem do prompt do Drafter (pipeline step 7, SPEC §4 / §5 #2).
 *
 * - SYSTEM (estático, cacheável): papel → regras de CONTENÇÃO → few-shot
 *   FIEL ao ofício real de Pariconha (`./fewshot.ts`).
 * - USER: `[extração]` (JSON inteiro, inclui `statusVerificado` e os índices
 *   dos achados) ANTES de `[tarefa]` — recência long-context (SPEC §7).
 *
 * CONTENÇÃO ESTRUTURAL REAL (SPEC §5 #2): o modelo NÃO escreve NENHUM texto
 * que entre no documento. Ele emite SOMENTE decisões estruturadas: `tipo`,
 * `selecoes[]` (referências por índice a achados JÁ EXISTENTES na extração)
 * e `leisCitadas[]` com `afirmacaoVigencia`. NÃO há campo de texto livre. O
 * corpo do ofício é montado 100% por TEMPLATES determinísticos do adapter
 * keyed pelo TIPO estruturado do achado. O prompt guia a SELEÇÃO; o código
 * REDIGE (templates). Vazamento de prosa de revogação é estruturalmente
 * impossível — não há canal de prosa do modelo.
 */

import type { EditalExtraction } from '../../domain/schema.ts';
import { renderFewShots } from './fewshot.ts';

const REGRAS = `Você é um analista de licitações que DECIDE o conteúdo de \
ofícios formais (pedidos de esclarecimento e impugnações) endereçados ao \
órgão licitante, em nome de uma empresa interessada no certame.

Você NÃO escreve, NÃO redige e NÃO produz NENHUM texto livre que entre no \
documento. O sistema monta o ofício inteiro deterministicamente, por \
TEMPLATES, a partir das suas DECISÕES ESTRUTURADAS. Você apenas seleciona, \
referencia e ordena — sem prosa.

CONTRATO DE SAÍDA — VOCÊ PRODUZ APENAS:

1. "tipo": "esclarecimento" para divergências/ambiguidades; "impugnacao" \
quando houver ilegalidade/restrição indevida que justifique impugnar.

2. "selecoes": uma lista que escolhe QUAIS achados JÁ EXISTENTES na extração \
levantar no ofício, e em que ORDEM. Cada item é \
{ "fonte": "incoerencia" | "trechoAmbiguo" | "pontoDeAtencao", "indice": N } \
onde "indice" é a posição (base 0) do achado no respectivo array da extração \
("incoerencias", "trechosAmbiguos", "pontosDeAtencao"). Só selecione achados \
que realmente justificam manifestação: incoerências de severidade ≥ média, \
trechos ambíguos, e pontosDeAtencao com "recomendaManifestacao": true. NÃO \
invente achados nem índices fora do range — índices inválidos são ignorados.

3. "leisCitadas": para CADA lei do edital relevante ao questionamento, \
decida "afirmacaoVigencia" ∈ {nenhuma, revogada, vigente} lendo o campo \
"statusVerificado" daquela lei na extração:
   - statusVerificado = "revogada"  → afirmacaoVigencia = "revogada".
   - QUALQUER OUTRO valor ("contestada", "inexistente", "nao-verificado", \
"vigente") → afirmacaoVigencia = "nenhuma".
   "leisCitadas" só pode conter leis presentes em "leisReferenciadas" da \
extração — NÃO invente normas, números ou anos. Mesmo essa decisão é \
revalidada e, se necessário, sobrescrita pelo sistema.

REGRA ABSOLUTA: você NÃO escreve título, argumento, justificativa, descrição \
nem qualquer frase — nem sobre vigência de norma, nem sobre nada. Qualquer \
texto livre que você emita é DESCARTADO pelo sistema e nunca entra no \
documento. O corpo do ofício e TODA frase de vigência são gerados por \
templates determinísticos a partir do TIPO estruturado de cada achado \
selecionado e do "statusVerificado" verificado.`;

/**
 * SYSTEM prompt completo (estático → cacheável pelo provider).
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
  'TAREFA: com base na extração acima, produza APENAS decisões ' +
  'estruturadas: "tipo"; "selecoes" (referências {fonte,indice} a achados ' +
  'JÁ EXISTENTES em incoerencias/trechosAmbiguos/pontosDeAtencao, na ordem ' +
  'desejada); e "leisCitadas" com "afirmacaoVigencia" derivada de ' +
  '"statusVerificado" (revogada só se statusVerificado="revogada"; senão ' +
  '"nenhuma"). NÃO escreva markdown, título, argumento nem qualquer frase — ' +
  'o sistema monta o ofício 100% por templates. Não invente leis, achados ' +
  'nem índices fora do range.';

/**
 * Monta o prompt do USUÁRIO: extração serializada (inclui os arrays
 * indexáveis de achados e `leisReferenciadas[].statusVerificado`) primeiro,
 * depois a tarefa — ordem de recência (SPEC §7).
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
