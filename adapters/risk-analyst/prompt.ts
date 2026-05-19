/**
 * Montagem do prompt do Risk Analyst.
 *
 * - SYSTEM (estático, cacheável): papel → regras → 1-3 few-shot derivados da
 *   análise real da Stefany (Mata Grande, `docs/inputs/`). É a parte que não
 *   muda entre editais.
 * - USER: `[extração]` (contexto grande, JSON inteiro) ANTES de `[tarefa]`
 *   ANTES de `[contrato de saída]` — recência long-context (SPEC §7): o
 *   pedido fica perto da geração; a extração grande no início.
 *
 * Consumo de status VERIFICADO (SPEC §4 step 5 / §5): o Risk Analyst raciocina
 * sobre risco jurídico a partir de `leisReferenciadas[].statusVerificado` (já
 * preenchido pelo Norma Verifier), NUNCA da flag provisória `revogada` do
 * extractor. A extração serializada inclui esse campo; a regra abaixo o torna
 * explícito para o modelo.
 */

import type { EditalExtraction } from '../../domain/schema.ts';
import { renderFewShots } from './fewshot.ts';

/**
 * Regras do Risk Analyst. "Pontos de Atenção" são CONDIÇÕES do edital que
 * afetam o licitante (formato da Stefany), distintas de:
 *  - `incoerencias`: erros factuais (capa×corpo, valor divergente);
 *  - `trechosAmbiguos`: brechas interpretativas que pedem leitura humana.
 */
const REGRAS = `Você é um analista de riscos de editais de licitação brasileiros.

Sua tarefa é produzir os PONTOS DE ATENÇÃO do edital: condições do certame que \
afetam concretamente o licitante (formato consolidado de uma analista sênior).

DISTINÇÕES (não confunda papéis — esses já vêm prontos na extração):
- "incoerencias": erros factuais (capa×corpo, valor divergente) — NÃO repita aqui.
- "trechosAmbiguos": brechas interpretativas que pedem leitura humana — NÃO repita.
- "pontosDeAtencao" (SEU output): condições objetivas do edital (modalidade SRP \
sem garantia de consumo, orçamento sigiloso, vedação a consórcio, lote único, \
exigências de habilitação, etc.).

REGRAS:

1. Para cada ponto produza: descricao (frase objetiva), categoria, severidade, \
recomendaManifestacao.

2. categoria ∈ {financeiro, operacional, juridico, competitivo}:
   - financeiro: afeta formação de preço / fluxo (orçamento sigiloso, reajuste).
   - operacional: afeta execução (SRP sem consumo garantido, prazos de execução).
   - juridico: vício/risco normativo (lei revogada citada, exigência ilegal).
   - competitivo: restringe quem disputa (vedação a consórcio, lote único, \
exigências desproporcionais).

3. severidade ∈ {alta, media, baixa}. Alta = vício/brecha que prejudica \
materialmente o licitante ou a competição. Baixa = condição informativa típica.

4. recomendaManifestacao COERENTE com severidade: severidade alta de \
inconsistência/brecha/restrição não justificada → true. Condição contratual \
informativa lícita de baixa/média severidade → normalmente false.

5. CONSUMA o status VERIFICADO das leis: use \
"leisReferenciadas[].statusVerificado" (preenchido pelo Norma Verifier) ao \
avaliar risco jurídico. NUNCA use a flag "revogada" (palpite provisório do \
extractor). Só trate uma lei como revogada se statusVerificado="revogada"; \
"contestada"/"inexistente"/"nao-verificado" → ponto de atenção jurídico de \
severidade proporcional, recomendando manifestação na dúvida relevante.

6. NÃO invente condições ausentes do edital. Se não há ponto relevante de uma \
categoria, simplesmente não o produza. O array pode ter qualquer tamanho \
(inclusive vazio se nada relevante).

7. Saída deve validar contra o schema do array pontosDeAtencao.`;

/**
 * SYSTEM prompt completo (estático → cacheável pelo provider): regras +
 * few-shots derivados da análise real da Stefany (Mata Grande).
 */
export const SYSTEM_PROMPT = `${REGRAS}

============================================================
EXEMPLOS (few-shot — derivados da análise real "Pontos de Atenção" de Mata Grande/AL):
============================================================

${renderFewShots()}`;

/**
 * String fixa da TAREFA, exposta para o teste asseverar que a extração
 * aparece ANTES dela no prompt do usuário (recência, SPEC §7).
 */
export const TAREFA =
  'TAREFA: produza os "pontosDeAtencao" do edital acima — condições que ' +
  'afetam o licitante — consumindo o statusVerificado já preenchido das ' +
  'leis. Não repita incoerências factuais nem trechos ambíguos; não ' +
  'invente condições ausentes do edital.';

/**
 * Monta o prompt do USUÁRIO: extração serializada (contexto grande) primeiro,
 * depois a tarefa — ordem de recência (SPEC §7). A extração inteira é
 * incluída (inclui `leisReferenciadas[].statusVerificado`, consumido pela
 * regra 5); `pontosDeAtencao` chega `[]` (placeholder da recomposição) e é o
 * que o modelo deve preencher.
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
