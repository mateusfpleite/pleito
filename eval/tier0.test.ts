import { describe, it, expect } from 'vitest';
import { checarContencao } from './tier0.ts';
import { EditalExtractionSchema } from '../domain/schema.ts';
import type { EditalExtraction } from '../domain/schema.ts';
import type { OficioGerado } from '../domain/ports.ts';

/**
 * DETERMINISTIC tests of the Tier 0 Gate (SPEC §11a, containment §5 #2).
 *
 * Property-based / structural — NO LLM, NO corpus-match. The proven
 * invariants are properties of the confrontation `afirmacaoVigencia`
 * (structured Drafter field) × `statusVerificado` (Norma Verifier field) ×
 * `matchNorma` (curated baseline), not "the LLM returned X"
 * (@superpowers:testing-anti-patterns).
 *
 * PRIMARY containment is the deterministic assembly in the Drafter (Phase
 * 8); this Tier 0 is a redundant structural backstop, but it is a HARD
 * GATE = 0 violations.
 *
 *  (a) clean analysis (coherent ofício / null ofício) → violacoes:[];
 *  (b) leisCitadas afirmacaoVigencia='revogada' but the corresponding
 *      leisReferenciadas statusVerificado is 'contestada' →
 *      afirmacao-indevida;
 *  (c) markdown "a norma perdeu vigência" without structured backing →
 *      lexico-inconsistente;
 *  (d) 5 revocation paraphrases without backing → all caught by the
 *      backstop;
 *  (e) baseline-divergente: extraction with a zona-cinzenta lei but
 *      statusVerificado='revogada' → baseline-divergente;
 *  (f) afirmacaoVigencia='vigente' in the ofício → violation.
 */

/** Minimal valid extraction (schema v3) — no leis, nothing to question. */
function extracaoBase(
  over: Partial<EditalExtraction> = {}
): EditalExtraction {
  const base = {
    municipio: 'Cidade Teste',
    uf: 'SP',
    ente: { tipo: 'prefeitura', razaoSocial: 'Prefeitura Teste', cnpj: null },
    modalidade: 'pregao-eletronico',
    numero: '001/2026',
    processoAdministrativo: null,
    dataPublicacao: null,
    dataSessao: null,
    uasg: null,
    regimeJuridico: 'lei-14133',
    objetoCorpo: 'Objeto de teste',
    objetoCapa: null,
    objetoSummary: 'Objeto de teste',
    tipoObjeto: ['outro'],
    secretariaDemandante: null,
    valor: { estimado: 1000, sigiloso: false, procedencia: 'capa' },
    moeda: 'BRL',
    criterioJulgamento: 'menor-preco',
    agrupamento: 'item',
    modoDisputa: 'aberto',
    regimeExecucao: null,
    vigenciaContrato: { meses: 12, prorrogavelAteMeses: null },
    vigenciaAtaRP: null,
    validadeProposta: null,
    habilitacao: {
      juridica: [],
      fiscalTrabalhista: [],
      economicoFinanceira: [],
      tecnica: [],
    },
    exigenciasRegulatorias: {
      licencaSanitaria: false,
      alvaraFuncionamento: false,
      vistoria: false,
      amostra: false,
      outros: [],
    },
    itensLicitados: [],
    leisReferenciadas: [],
    anexos: [],
    incoerencias: [],
    trechosAmbiguos: [],
    plataforma: null,
    subcontratacaoPermitida: null,
    intervaloMinimoLances: null,
    prazoRecursosDiasUteis: null,
    informacoesViabilidade: null,
    pontosDeAtencao: [],
    fonte: { pdfNativo: true, ocr: false, paginas: 1, url: null },
    ...over,
  };
  return EditalExtractionSchema.parse(base);
}

/** Referenced lei with a custom verified status. */
function leiRef(
  numero: string | null,
  ano: number | null,
  statusVerificado: EditalExtraction['leisReferenciadas'][number]['statusVerificado'],
  over: Partial<EditalExtraction['leisReferenciadas'][number]> = {}
) {
  return {
    descricao: `Norma ${numero ?? '?'}/${ano ?? '?'}`,
    escopo: 'federal' as const,
    tipoNorma: 'lei' as const,
    numero,
    ano,
    contextoNoEdital: 'citada no edital',
    revogada: false,
    statusVerificado,
    fonteVerificacao: null,
    ...over,
  };
}

describe('checarContencao — structural Tier 0', () => {
  it('(a) clean analysis: coherent ofício → violacoes:[]', () => {
    const extracao = extracaoBase({
      leisReferenciadas: [leiRef('8666', 1993, 'revogada')],
    });
    const oficio: OficioGerado = {
      tipo: 'esclarecimento',
      markdown:
        'A norma nº 8666/1993 encontra-se revogada, conforme verificação.',
      leisCitadas: [
        { numero: '8666', ano: 1993, afirmacaoVigencia: 'revogada' },
      ],
    };
    expect(checarContencao({ extracao, oficio }).violacoes).toEqual([]);
  });

  it('(a2) clean analysis: ofício null → violacoes:[]', () => {
    const extracao = extracaoBase();
    expect(
      checarContencao({ extracao, oficio: null }).violacoes
    ).toEqual([]);
  });

  it('(a3) ofício with law afirmacaoVigencia=nenhuma and neutral markdown → []', () => {
    const extracao = extracaoBase({
      leisReferenciadas: [leiRef('14133', 2021, 'vigente')],
    });
    const oficio: OficioGerado = {
      tipo: 'esclarecimento',
      markdown: 'Solicita-se confirmação sobre a norma aplicável.',
      leisCitadas: [
        { numero: '14133', ano: 2021, afirmacaoVigencia: 'nenhuma' },
      ],
    };
    expect(checarContencao({ extracao, oficio }).violacoes).toEqual([]);
  });

  it('(b) afirmacaoVigencia=revogada but statusVerificado=contestada → afirmacao-indevida', () => {
    // Fictitious municipal lei (NOT in the curated baseline) — isolates
    // the afirmacaoVigencia×statusVerificado confrontation without baseline
    // noise.
    const extracao = extracaoBase({
      leisReferenciadas: [
        leiRef('4321', 2015, 'contestada', { escopo: 'municipal' }),
      ],
    });
    // Neutral markdown (no lexicon) to isolate check 1 from the lexical backstop.
    const oficio: OficioGerado = {
      tipo: 'esclarecimento',
      markdown: 'Solicita-se esclarecimento sobre a norma nº 4321/2015.',
      leisCitadas: [
        { numero: '4321', ano: 2015, afirmacaoVigencia: 'revogada' },
      ],
    };
    const { violacoes } = checarContencao({ extracao, oficio });
    expect(violacoes).toHaveLength(1);
    expect(violacoes[0].tipo).toBe('afirmacao-indevida');
  });

  it('(b2) afirmacaoVigencia=revogada on a NON-identifiable law (numero null) → afirmacao-indevida', () => {
    const extracao = extracaoBase({
      leisReferenciadas: [leiRef(null, 1988, 'nao-verificado')],
    });
    const oficio: OficioGerado = {
      tipo: 'esclarecimento',
      markdown: 'Norma revogada.',
      leisCitadas: [{ numero: null, ano: 1988, afirmacaoVigencia: 'revogada' }],
    };
    const { violacoes } = checarContencao({ extracao, oficio });
    expect(violacoes.some((v) => v.tipo === 'afirmacao-indevida')).toBe(true);
  });

  it('(c) markdown "a norma perdeu vigência" without support → lexico-inconsistente', () => {
    const extracao = extracaoBase({
      leisReferenciadas: [leiRef('1234', 2010, 'vigente')],
    });
    const oficio: OficioGerado = {
      tipo: 'esclarecimento',
      markdown:
        'Quanto à norma nº 1234/2010, a norma perdeu vigência segundo entendimento.',
      leisCitadas: [
        { numero: '1234', ano: 2010, afirmacaoVigencia: 'nenhuma' },
      ],
    };
    const { violacoes } = checarContencao({ extracao, oficio });
    expect(violacoes.some((v) => v.tipo === 'lexico-inconsistente')).toBe(
      true
    );
  });

  it('(d) 5 revocation paraphrases without support → all caught by the backstop', () => {
    const parafrases = [
      'a norma foi revogada pela legislação superveniente',
      'a norma perdeu vigência em 2023',
      'a norma não está mais em vigor',
      'a norma deixou de viger há anos',
      'a norma está sem vigência e caducou',
    ];
    for (const p of parafrases) {
      const extracao = extracaoBase({
        leisReferenciadas: [leiRef('999', 2000, 'vigente')],
      });
      const oficio: OficioGerado = {
        tipo: 'esclarecimento',
        markdown: `Sobre a norma nº 999/2000: ${p}.`,
        leisCitadas: [
          { numero: '999', ano: 2000, afirmacaoVigencia: 'nenhuma' },
        ],
      };
      const { violacoes } = checarContencao({ extracao, oficio });
      expect(
        violacoes.some((v) => v.tipo === 'lexico-inconsistente'),
        `paráfrase não pega: "${p}"`
      ).toBe(true);
    }
  });

  it('(e) baseline-divergente: zona-cinzenta law but statusVerificado=revogada', () => {
    // The only zona-cinzenta entry in the curated baseline: IN SEGES nº
    // 05/2017 (numero "5", ano 2017, federal, instrucao-normativa).
    // Expected by the category: 'contestada'. Marking 'revogada' = improper
    // binarization.
    const extracao = extracaoBase({
      leisReferenciadas: [
        leiRef('5', 2017, 'revogada', {
          escopo: 'federal',
          tipoNorma: 'instrucao-normativa',
        }),
      ],
    });
    const { violacoes } = checarContencao({ extracao, oficio: null });
    expect(
      violacoes.some((v) => v.tipo === 'baseline-divergente'),
      JSON.stringify(violacoes)
    ).toBe(true);
  });

  it('(e2) zona-cinzenta never becomes binary in the ofício: afirmacaoVigencia=revogada → violation', () => {
    const extracao = extracaoBase({
      leisReferenciadas: [
        leiRef('5', 2017, 'contestada', {
          escopo: 'federal',
          tipoNorma: 'instrucao-normativa',
        }),
      ],
    });
    const oficio: OficioGerado = {
      tipo: 'esclarecimento',
      markdown: 'A norma nº 5/2017 encontra-se revogada.',
      leisCitadas: [
        { numero: '5', ano: 2017, afirmacaoVigencia: 'revogada' },
      ],
    };
    const { violacoes } = checarContencao({ extracao, oficio });
    expect(violacoes.length).toBeGreaterThan(0);
    expect(violacoes.some((v) => v.tipo === 'zona-cinzenta-binarizada')).toBe(
      true
    );
  });

  it('(f) afirmacaoVigencia=vigente in the ofício → violation', () => {
    const extracao = extracaoBase({
      leisReferenciadas: [leiRef('14133', 2021, 'vigente')],
    });
    const oficio: OficioGerado = {
      tipo: 'esclarecimento',
      markdown: 'A norma nº 14133/2021 está vigente.',
      leisCitadas: [
        { numero: '14133', ano: 2021, afirmacaoVigencia: 'vigente' },
      ],
    };
    const { violacoes } = checarContencao({ extracao, oficio });
    expect(violacoes.some((v) => v.tipo === 'afirmacao-vigencia-proativa')).toBe(
      true
    );
  });

  it('gold-like: extraction without statusVerificado (nao-verificado) + oficio null → []', () => {
    // Gold fixtures are raw extractions (statusVerificado default
    // nao-verificado). There must be no baseline-divergente: nao-verificado
    // is not a divergence, it is "not verified yet".
    const extracao = extracaoBase({
      leisReferenciadas: [
        leiRef('8666', 1993, 'nao-verificado'),
        leiRef('14133', 2021, 'nao-verificado'),
        leiRef('8987', 1995, 'nao-verificado'),
      ],
    });
    expect(
      checarContencao({ extracao, oficio: null }).violacoes
    ).toEqual([]);
  });
});
