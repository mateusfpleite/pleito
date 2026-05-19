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
 * Os dois exemplos demonstram a REGRA DE CONTENÇÃO (SPEC §5 #2 / §11a), que é
 * o núcleo deste agente:
 *
 *  - EXEMPLO 1 (lei VERIFICADA como revogada → afirmacaoVigencia="revogada"):
 *    quando o Norma Verifier confirmou a revogação, o ofício PODE afirmá-la
 *    e usá-la como fundamento da divergência.
 *  - EXEMPLO 2 (lei em zona-cinzenta / não-verificada → afirmacaoVigencia=
 *    "nenhuma"): NUNCA afirmar (não)vigência; transformar em PERGUNTA ao
 *    órgão ("solicita-se confirmação/esclarecimento sobre a norma
 *    aplicável...").
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
  "markdown": "À Comissão de Licitação / Sr. Pregoeiro\\nPrefeitura Municipal de Pariconha/AL\\n\\n**Assunto:** Pedido de esclarecimento — Pregão Eletrônico nº 008/2026.\\n\\nPrezados Senhores,\\n\\nA empresa interessada em participar do certame em epígrafe vem, tempestivamente, solicitar os seguintes esclarecimentos:\\n\\n1. **Fundamento legal do certame.** O preâmbulo do edital indica como base jurídica a Lei nº 8.666/1993, a qual foi revogada pela Lei nº 14.133/2021 (art. 193, II). Solicita-se esclarecimento sobre qual o regime jurídico efetivamente aplicável ao presente certame e, sendo o caso, a devida retificação do instrumento convocatório, de modo a assegurar segurança jurídica aos licitantes.\\n\\nDiante do exposto, requer-se a prestação dos esclarecimentos acima, se necessário com a republicação do edital e reabertura do prazo legal.\\n\\nAtenciosamente,\\n[Identificação do solicitante]"
}`,
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
  "markdown": "À Comissão de Licitação / Sr. Pregoeiro\\nPrefeitura Municipal de Pariconha/AL\\n\\n**Assunto:** Pedido de esclarecimento — Pregão Eletrônico nº 008/2026.\\n\\nPrezados Senhores,\\n\\nA empresa interessada vem solicitar os seguintes esclarecimentos:\\n\\n1. **Norma aplicável à habilitação técnica.** O edital invoca a Instrução Normativa SEGES nº 05/2017 como base das exigências de habilitação técnica. Considerando as alterações normativas supervenientes e eventual recepção sob a Lei nº 14.133/2021, solicita-se confirmação sobre qual a norma efetivamente aplicável e o exato alcance das exigências dela decorrentes para fins de habilitação neste certame.\\n\\n2. **Critério de julgamento.** Solicita-se esclarecimento quanto à redação do item que trata do critério de julgamento, de modo a dirimir a ambiguidade apontada e permitir a correta formulação das propostas.\\n\\nDiante do exposto, requer-se a prestação dos esclarecimentos acima.\\n\\nAtenciosamente,\\n[Identificação do solicitante]"
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
      `### ${fs.titulo}\n\nContexto da extração:\n${fs.contexto}\n\nOfício esperado (objeto):\n${fs.saida}`
  ).join('\n\n---\n\n');
}
