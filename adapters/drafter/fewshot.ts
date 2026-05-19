/**
 * Few-shot do Drafter — modelado FIELMENTE no "OFÍCIO DE ESCLARECIMENTO
 * Pregão Eletrônico nº 008/2026 — Prefeitura Municipal de Pariconha/AL",
 * artefato real enviado pela Stefany na rodada de validação (PROVENANCE.md
 * §8 / SPEC §7 — gold versionado). O TEXTO LITERAL do ofício não foi
 * arquivado como asset (PROVENANCE.md apenas o referencia); este few-shot
 * reproduz a ESTRUTURA documentada do artefato — não inventa formato.
 *
 * CONTENÇÃO ESTRUTURAL REAL (SPEC §5 #2 / §11a): o modelo NÃO escreve NENHUM
 * texto que entre no documento. Ele emite SOMENTE `tipo`, `selecoes[]`
 * (referências por índice a achados JÁ EXISTENTES na extração) e
 * `leisCitadas[]` com `afirmacaoVigencia`. O corpo do ofício e TODA frase de
 * vigência são montados 100% por TEMPLATES determinísticos do adapter, keyed
 * pelo TIPO estruturado de cada achado. Os exemplos ensinam a SELECIONAR e
 * ORDENAR achados, NUNCA a redigir.
 *
 *  - EXEMPLO 1 (lei VERIFICADA revogada → afirmacaoVigencia="revogada"):
 *    o modelo seleciona a incoerência e registra o status; a frase de
 *    revogação é montada pelo adapter via template, não pelo modelo.
 *  - EXEMPLO 2 (lei zona-cinzenta / não-verificada → afirmacaoVigencia=
 *    "nenhuma"): o modelo seleciona os achados; o adapter emite só
 *    pergunta-template ao órgão.
 *
 * Vivem no SYSTEM prompt (estático → cacheável pelo provider, SPEC §7).
 */

type FewShot = {
  titulo: string;
  contexto: string;
  saida: string;
};

const FEW_SHOTS: FewShot[] = [
  {
    titulo:
      'EXEMPLO 1 — lei VERIFICADA revogada (afirmacaoVigencia="revogada" permitido)',
    contexto: `Pregão Eletrônico nº 008/2026 — Prefeitura Municipal de \
Pariconha/AL. extracao.incoerencias[0] = {tipo:"lei-revogada", \
severidade:"alta"} (o preâmbulo fundamenta o certame na "Lei nº 8.666/1993"). \
extracao.leisReferenciadas inclui {numero:"8666", ano:1993, \
statusVerificado:"revogada"} (confirmada pelo Norma Verifier).`,
    saida: `{
  "tipo": "esclarecimento",
  "selecoes": [
    { "fonte": "incoerencia", "indice": 0 }
  ],
  "leisCitadas": [
    { "numero": "8666", "ano": 1993, "afirmacaoVigencia": "revogada" }
  ]
}
// NOTA: o modelo NÃO escreveu NENHUM texto. Só selecionou a incoerência [0]
// e registrou o status. O adapter, vendo afirmacaoVigencia="revogada"
// (statusVerificado verificado, match único), MONTA deterministicamente a
// frase-template de revogação no ofício final.`,
  },
  {
    titulo:
      'EXEMPLO 2 — lei NÃO verificada como revogada (afirmacaoVigencia="nenhuma" → pergunta)',
    contexto: `Pregão Eletrônico nº 008/2026 — Pariconha/AL. \
extracao.pontosDeAtencao[0] = {categoria:"juridico", \
recomendaManifestacao:true} (exigência de habilitação técnica baseada na \
"Instrução Normativa SEGES nº 05/2017"). extracao.trechosAmbiguos[0] = \
{secaoOndeAparece:"critério de julgamento"}. \
extracao.leisReferenciadas inclui {numero:"5", ano:2017, \
statusVerificado:"contestada"} (zona-cinzenta — NÃO confirmada revogada).`,
    saida: `{
  "tipo": "esclarecimento",
  "selecoes": [
    { "fonte": "pontoDeAtencao", "indice": 0 },
    { "fonte": "trechoAmbiguo", "indice": 0 }
  ],
  "leisCitadas": [
    { "numero": "5", "ano": 2017, "afirmacaoVigencia": "nenhuma" }
  ]
}
// NOTA: o modelo só selecionou os achados (sem texto). statusVerificado≠
// "revogada" → afirmacaoVigencia="nenhuma". O adapter emite apenas
// templates neutros + pergunta-template ao órgão sobre a norma aplicável.`,
  },
];

/**
 * Renderiza os few-shots como bloco de texto para embutir no SYSTEM prompt.
 * Estático (mesma saída sempre) → cacheável pelo provider.
 */
export function renderFewShots(): string {
  return FEW_SHOTS.map(
    (fs) =>
      `### ${fs.titulo}\n\nContexto da extração:\n${fs.contexto}\n\nDecisão estruturada esperada (objeto):\n${fs.saida}`
  ).join('\n\n---\n\n');
}
