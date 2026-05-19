/**
 * Few-shot do Drafter — modelado FIELMENTE no "OFÍCIO DE ESCLARECIMENTO
 * Pregão Eletrônico nº 008/2026 — Prefeitura Municipal de Pariconha/AL",
 * artefato real enviado pela Stefany na rodada de validação (PROVENANCE.md
 * §8 / SPEC §7 — gold versionado). O TEXTO LITERAL do ofício não foi
 * arquivado como asset no repositório (PROVENANCE.md apenas o referencia);
 * este few-shot reproduz com fidelidade a ESTRUTURA documentada do
 * artefato — não inventa formato:
 *
 *   1. Cabeçalho endereçado ao órgão (À Comissão / Pregoeiro);
 *   2. Linha "Assunto:" (referência ao pregão);
 *   3. Saudação ("Prezados Senhores,");
 *   4. Pontos NUMERADOS, cada um com a descrição objetiva da divergência
 *      seguida de PERGUNTAS concretas ao órgão;
 *   5. Encerramento cordial + identificação do solicitante.
 *
 * Os dois exemplos demonstram a REGRA DE CONTENÇÃO ESTRUTURAL (SPEC §5 #2 /
 * §11a): o modelo produz só `pontos` (titulo+argumento) + `leisCitadas`. Ele
 * NUNCA escreve markdown nem frase de (não)vigência — o adapter monta o
 * ofício deterministicamente (frase de revogação = template keyed pelo
 * statusVerificado verificado).
 *
 *  - EXEMPLO 1 (lei VERIFICADA como revogada → afirmacaoVigencia="revogada"):
 *    o modelo só registra o status e o argumento NEUTRO; a frase de
 *    revogação é montada pelo adapter, não pelo modelo.
 *  - EXEMPLO 2 (lei em zona-cinzenta / não-verificada → afirmacaoVigencia=
 *    "nenhuma"): argumento NÃO afirma (não)vigência; o adapter emite só
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
Pariconha/AL. Incoerência (severidade alta): o preâmbulo fundamenta o \
certame na "Lei nº 8.666/1993". leisReferenciadas inclui {numero:"8666", \
ano:1993, statusVerificado:"revogada"} (confirmada pelo Norma Verifier).`,
    saida: `{
  "tipo": "esclarecimento",
  "leisCitadas": [
    { "numero": "8666", "ano": 1993, "afirmacaoVigencia": "revogada" }
  ],
  "pontos": [
    {
      "titulo": "Fundamento legal do certame",
      "argumento": "O preâmbulo do edital indica como base jurídica a Lei nº 8.666/1993, cujo regime de aplicação ao certame se questiona, de modo a assegurar segurança jurídica aos licitantes."
    }
  ]
}
// NOTA: o modelo NÃO escreveu nenhuma frase afirmando revogação. O adapter,
// vendo afirmacaoVigencia="revogada" (statusVerificado verificado),
// MONTA deterministicamente a frase-template de revogação no ofício final.`,
  },
  {
    titulo:
      'EXEMPLO 2 — lei NÃO verificada como revogada (afirmacaoVigencia="nenhuma" → pergunta)',
    contexto: `Pregão Eletrônico nº 008/2026 — Pariconha/AL. O edital exige \
habilitação técnica com base na "Instrução Normativa SEGES nº 05/2017". \
leisReferenciadas inclui {numero:"5", ano:2017, \
statusVerificado:"contestada"} (zona-cinzenta — alcance controverso, NÃO \
confirmada revogada). Trecho ambíguo sobre o critério de julgamento.`,
    saida: `{
  "tipo": "esclarecimento",
  "leisCitadas": [
    { "numero": "5", "ano": 2017, "afirmacaoVigencia": "nenhuma" }
  ],
  "pontos": [
    {
      "titulo": "Norma aplicável à habilitação técnica",
      "argumento": "O edital invoca a Instrução Normativa SEGES nº 05/2017 como base das exigências de habilitação técnica; solicita-se confirmação sobre a norma efetivamente aplicável e o exato alcance das exigências dela decorrentes."
    },
    {
      "titulo": "Critério de julgamento",
      "argumento": "A redação do item que trata do critério de julgamento comporta mais de uma interpretação, dificultando a correta formulação das propostas."
    }
  ]
}
// NOTA: argumento NEUTRO — não afirma (não)vigência da IN 05/2017. O adapter
// emite apenas pergunta-template ao órgão sobre a norma aplicável.`,
  },
];

/**
 * Renderiza os few-shots como bloco de texto para embutir no SYSTEM prompt.
 * Estático (mesma saída sempre) → cacheável pelo provider.
 */
export function renderFewShots(): string {
  return FEW_SHOTS.map(
    (fs) =>
      `### ${fs.titulo}\n\nContexto da extração:\n${fs.contexto}\n\nOfício esperado (objeto):\n${fs.saida}`
  ).join('\n\n---\n\n');
}
