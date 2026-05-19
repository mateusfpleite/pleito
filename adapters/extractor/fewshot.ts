/**
 * Few-shot do Extractor — CRIADOS na Phase 5 (não existem no POC; SPEC §7
 * exige derivá-los dos gold reais). São 3 mini-exemplos curtos derivados de
 * `fixtures/gold/`, cada um cobrindo uma armadilha que o extractor precisa
 * acertar de forma consistente:
 *
 *  1. Jaborandi (BA)   — CAPA MENTIROSA: objetoCapa (pipas/estradas) ≠
 *                        objetoCorpo (serviços funerários) ⇒ preencher
 *                        ambos + incoerência objeto-divergente sev. alta.
 *  2. Dom Basílio (BA) — VALOR DIVERGENTE: capa R$ 265.690 vs TR
 *                        R$ 265.960 ⇒ valor.estimado do TR (mais detalhado)
 *                        + incoerência valor-divergente sev. alta.
 *  3. Niterói (RJ)     — VALOR SIGILOSO: estimado ausente ⇒
 *                        valor.estimado=null, sigiloso=true, procedência
 *                        do preâmbulo (não inventar número).
 *
 * Trecho de entrada curto → recorte da saída estruturada esperada. Vivem no
 * SYSTEM prompt (estático, cacheável — SPEC §7), não no prompt do usuário.
 * Proveniência: extrações congeladas em `fixtures/gold/{jaborandi,
 * dombasilio,niteroi}.json` (POC, Gemini 2.5 Flash, schema v3).
 */

type FewShot = {
  titulo: string;
  trechoEntrada: string;
  saidaParcial: string;
};

const FEW_SHOTS: FewShot[] = [
  {
    titulo: 'EXEMPLO 1 — capa mentirosa (objeto divergente capa vs corpo)',
    trechoEntrada: `CAPA: "...registro de preços para locação de caminhões pipa e máquinas pesadas para manutenção de estradas vicinais do Município de Jaborandi - Bahia."
TERMO DE REFERÊNCIA: "...contratação de empresa para prestação de SERVIÇOS FUNERÁRIOS E TRASLADOS destinados ao Município de Jaborandi - Bahia."`,
    saidaParcial: `{
  "objetoCapa": "...locação de caminhões pipa e máquinas pesadas ... estradas vicinais ...",
  "objetoCorpo": "...prestação de serviços funerários e traslados ...",
  "incoerencias": [
    {
      "tipo": "objeto-divergente",
      "descricao": "O objeto da capa (caminhões pipa/estradas) diverge do corpo e TR (serviços funerários).",
      "severidade": "alta"
    }
  ]
}`,
  },
  {
    titulo: 'EXEMPLO 2 — valor divergente (capa vs termo de referência)',
    trechoEntrada: `CAPA: "Valor Total da Contratação: R$ 265.690,00".
TERMO DE REFERÊNCIA (tabela 1.1 e item 8.1): "Valor total estimado: R$ 265.960,00" (soma detalhada dos itens).`,
    saidaParcial: `{
  "valor": { "estimado": 265960, "sigiloso": false, "procedencia": "termo-referencia" },
  "incoerencias": [
    {
      "tipo": "valor-divergente",
      "descricao": "Capa R$ 265.690,00 vs TR R$ 265.960,00; o TR (soma dos itens) é mais detalhado.",
      "severidade": "alta"
    }
  ]
}`,
  },
  {
    titulo: 'EXEMPLO 3 — valor sigiloso (não inventar número)',
    trechoEntrada: `PREÂMBULO: "O valor estimado da contratação é SIGILOSO, nos termos do art. 24 da Lei nº 14.133/2021, sendo divulgado apenas após o encerramento da fase de lances."`,
    saidaParcial: `{
  "valor": { "estimado": null, "sigiloso": true, "procedencia": "preambulo" }
}`,
  },
];

/**
 * Renderiza os few-shots como bloco de texto para embutir no SYSTEM prompt.
 * Estático (mesma saída sempre) → cacheável pelo provider.
 */
export function renderFewShots(): string {
  return FEW_SHOTS.map(
    (fs) =>
      `### ${fs.titulo}\n\nTrecho do edital:\n${fs.trechoEntrada}\n\nSaída estruturada esperada (recorte):\n${fs.saidaParcial}`
  ).join('\n\n---\n\n');
}
