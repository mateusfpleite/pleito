/**
 * Montagem do prompt do Extractor.
 *
 * - SYSTEM (estático, cacheável): papel → regras validadas (reaproveitadas
 *   1:1 do POC `src/extract.ts`, prompt já validado contra editais reais) →
 *   1-3 few-shot (SPEC §7). É a parte que não muda entre editais.
 * - USER: `[documento]` ANTES de `[tarefa]` ANTES de `[contrato de saída]`
 *   — recência long-context (SPEC §7): o pedido fica junto do fim, perto
 *   da geração, e o documento grande no início.
 *
 * `pontosDeAtencao` é DELIBERADAMENTE omitido do contrato: é do Risk
 * Analyst (pipeline step 5, SPEC §4), não do Extractor (step 2). Forçar o
 * modelo a preenchê-lo aqui o faria fabricar dado. O schema usado no
 * `generateObject` (ExtractorOutputSchema) também o omite.
 */

import { renderFewShots } from './fewshot.ts';

/**
 * Regras de extração validadas no POC (`src/extract.ts`). Reaproveitadas
 * integralmente — só foi removida a menção implícita a campos do Risk
 * Analyst (não havia) e adicionada a nota explícita de não fabricar
 * pontos de atenção.
 */
const REGRAS = `Você é um especialista em análise de editais de licitação brasileiros.
Sua tarefa é extrair informações estruturadas do edital fornecido, seguindo rigorosamente o schema.

INSTRUÇÕES CRÍTICAS:

1. Sempre leia o CORPO do edital, não apenas a capa. A capa pode ter erros de copy-paste (objeto trocado, valores divergentes). Verifique no corpo, preâmbulo e termo de referência.

2. Se objetoCapa diverge de objetoCorpo, preencha ambos e marque uma incoerência tipo "objeto-divergente" com severidade "alta". Se forem iguais, deixe objetoCapa como null.

3. Se o valor estimado divergir entre peças (ex: capa vs TR), marque incoerência tipo "valor-divergente".

4. Lei revogada citada anacronicamente (ex: Lei 8.666/93 ou Lei 10.520/02 num edital regido pela Lei 14.133/2021) deve ter revogada: true.

5. Se um anexo é referenciado mas não está presente no texto fornecido (ex: TR mencionado mas conteúdo ausente), marque presenteNoArquivo: false.

6. Identifique trechos AMBÍGUOS (brechas/aberturas) que pedem leitura humana cuidadosa — exemplos: "complexidade tecnológica e operacional equivalente" sem quantitativo, "a critério da Administração", prazos com placeholders ("XX dias"), valor "sigiloso" sem orientação clara.

7. Para itens licitados (urnas, mortalha, tanatopraxia, etc.), classifique por tipo e público-alvo. Se o TR não está presente, deixe itensLicitados como array vazio.

8. NÃO invente campos. Use null onde o edital não informar.

9. SEMPRE preencha leisReferenciadas com TODAS as leis/decretos/portarias/INs citadas no texto, mesmo as comuns. Para cada uma, identifique tipoNorma corretamente (lei/decreto/portaria/regulamento-interno/instrucao-normativa/etc).

10. regimeJuridico é o regime PRINCIPAL do edital (não as leis subsidiárias). Ex: empresa estatal usa "lei-13303" mesmo citando outras leis.

11. Datas devem estar em formato ISO 8601 (YYYY-MM-DD ou YYYY-MM-DDTHH:mm:ss-03:00 com timezone se disponível).

12. JSON deve sempre validar contra o schema.

13. NÃO produza "pontos de atenção" / análise de risco — esse não é o seu papel; é etapa posterior do pipeline. Limite-se à extração factual.`;

/**
 * SYSTEM prompt completo (estático → cacheável pelo provider): regras
 * validadas + few-shots derivados dos gold.
 */
export const SYSTEM_PROMPT = `${REGRAS}

============================================================
EXEMPLOS (few-shot — derivados de editais reais):
============================================================

${renderFewShots()}`;

/**
 * String fixa da TAREFA, exposta para o teste asseverar que o documento
 * aparece ANTES dela no prompt do usuário (recência, SPEC §7).
 */
export const TAREFA =
  'TAREFA: extraia as informações estruturadas do edital acima, ' +
  'seguindo rigorosamente o schema fornecido. Use null onde o edital ' +
  'não informar; não invente campos; não produza análise de risco.';

/**
 * Monta o prompt do USUÁRIO: documento (contexto grande) primeiro, depois
 * a tarefa, depois a nota de contrato — ordem de recência (SPEC §7).
 */
export function montarPrompt(texto: string): string {
  return [
    '---INÍCIO DO EDITAL---',
    texto,
    '---FIM DO EDITAL---',
    '',
    TAREFA,
  ].join('\n');
}
