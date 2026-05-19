/**
 * Few-shot do Risk Analyst — derivados da análise REAL da Stefany para o
 * Pregão Eletrônico 016/2026 de Mata Grande/AL
 * (`docs/inputs/Principais pontos - Mata Grande - AL.pdf`, seção "Pontos de
 * Atenção"). É o formato-OURO: condições do edital que afetam o licitante,
 * distintas de incoerências factuais e de trechos ambíguos interpretativos
 * (SPEC §6 / plano Phase 7).
 *
 * Os 3 exemplos abaixo são FIÉIS aos pontos que ela escreveu — não inventados:
 *
 *  1. "Contratação via Sistema de Registro de Preços, sem garantia de consumo
 *     integral" — risco OPERACIONAL de baixa/média severidade: é uma condição
 *     informativa típica de SRP, não uma brecha; não recomenda manifestação
 *     por si só.
 *  2. "Orçamento sigiloso" — risco FINANCEIRO de média severidade: dificulta a
 *     formação de preço; é lícito (art. 24 Lei 14.133), informativo → não
 *     recomenda manifestação isoladamente.
 *  3. "Vedação à participação em consórcio" — risco COMPETITIVO de severidade
 *     alta: restringe quem pode disputar; quando não justificada no edital,
 *     pode ser questionada → recomenda manifestação.
 *
 * (Outros pontos reais dela usados como repertório de estilo, não como shots:
 * "Licitação em lote único", "Vedação à participação em consórcio",
 * "Possibilidade de desclassificação por divergência entre proposta anexada
 * e sistema", "Município não garante quantitativo mínimo de execução".)
 *
 * Vivem no SYSTEM prompt (estático → cacheável pelo provider, SPEC §7), não
 * no prompt do usuário.
 */

type FewShot = {
  titulo: string;
  contextoEntrada: string;
  saidaEsperada: string;
};

const FEW_SHOTS: FewShot[] = [
  {
    titulo:
      'EXEMPLO 1 — SRP sem garantia de consumo (condição operacional informativa)',
    contextoEntrada: `Modalidade: Pregão Eletrônico – Sistema de Registro de Preços (SRP). \
A ata de registro de preços não obriga a Administração a contratar a totalidade \
estimada; o município não garante quantitativo mínimo de execução.`,
    saidaEsperada: `{
  "descricao": "Contratação via Sistema de Registro de Preços, sem garantia de consumo integral; o município não garante quantitativo mínimo de execução.",
  "categoria": "operacional",
  "severidade": "media",
  "recomendaManifestacao": false
}`,
  },
  {
    titulo:
      'EXEMPLO 2 — orçamento sigiloso (risco financeiro, lícito, informativo)',
    contextoEntrada: `Valor Estimado: Sigiloso até o encerramento da fase de \
julgamento das propostas (art. 24 da Lei nº 14.133/2021). statusVerificado da \
Lei 14.133/2021 = "vigente".`,
    saidaEsperada: `{
  "descricao": "Orçamento sigiloso até o encerramento da fase de julgamento das propostas, o que dificulta a formação de preço pelo licitante.",
  "categoria": "financeiro",
  "severidade": "media",
  "recomendaManifestacao": false
}`,
  },
  {
    titulo:
      'EXEMPLO 3 — vedação a consórcio (restrição competitiva, recomenda manifestação)',
    contextoEntrada: `Participação: vedada a participação de empresas em \
consórcio, sem justificativa técnica explícita no edital.`,
    saidaEsperada: `{
  "descricao": "Vedação à participação em consórcio sem justificativa técnica explícita, restringindo a competitividade do certame.",
  "categoria": "competitivo",
  "severidade": "alta",
  "recomendaManifestacao": true
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
      `### ${fs.titulo}\n\nContexto da extração:\n${fs.contextoEntrada}\n\nPonto de atenção esperado:\n${fs.saidaEsperada}`
  ).join('\n\n---\n\n');
}
