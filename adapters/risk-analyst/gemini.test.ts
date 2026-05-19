import { describe, it, expect } from 'vitest';
import { GeminiRiskAnalyst } from './gemini.ts';
import { montarPrompt, TAREFA, SYSTEM_PROMPT } from './prompt.ts';
import { EditalExtractionSchema } from '../../domain/schema.ts';
import type { EditalExtraction } from '../../domain/schema.ts';

/**
 * DETERMINISTIC tests of the Risk Analyst. LanguageModel mocked — we NEVER
 * call the real Gemini nor test "the LLM returned X"
 * (@superpowers:testing-anti-patterns). Proven invariants:
 *
 *  (assembly) the prompt places the EXTRACTION before the TASK string
 *      (long-context recency, SPEC §7); few-shot lives in the SYSTEM
 *      (cacheable), not in the user prompt;
 *  (a) fake model with valid points → adapter returns an EditalExtraction
 *      with `pontosDeAtencao` filled and valid against
 *      EditalExtractionSchema;
 *  (b) fake model with `categoria` outside the enum → adapter rejects
 *      (throw);
 *  (c) the fake's severidade/categoria/recomendaManifestacao are PRESERVED
 *      in the output (the adapter does not silently post-process, it
 *      trusts+revalidates);
 *  (d) non-pontosDeAtencao fields of the input extraction are NOT mutated,
 *      including the leis' `statusVerificado` (the Risk Analyst consumes,
 *      it does not rewrite, the verified status).
 *
 * The mock implements only the `generateObject` surface the adapter uses:
 * `doGenerate` returns JSON in `content`. `generateObject` (JSON mode)
 * parses + validates against the points-array schema.
 */

/** Valid base extraction; each test injects `pontosDeAtencao`/`leisReferenciadas`. */
function baseExtraction(
  overrides: Partial<EditalExtraction> = {}
): EditalExtraction {
  return EditalExtractionSchema.parse({
    municipio: 'Mata Grande',
    uf: 'AL',
    ente: {
      tipo: 'prefeitura',
      razaoSocial: 'Prefeitura Municipal de Mata Grande',
      cnpj: null,
    },
    modalidade: 'pregao-eletronico',
    numero: '16/2026',
    processoAdministrativo: null,
    dataPublicacao: null,
    dataSessao: null,
    uasg: null,
    regimeJuridico: 'lei-14133',
    objetoCorpo: 'Serviços funerários',
    objetoCapa: null,
    objetoSummary: 'Serviços funerários',
    tipoObjeto: ['servicos-funerarios-completos'],
    secretariaDemandante: null,
    valor: { estimado: null, sigiloso: true, procedencia: 'preambulo' },
    moeda: 'BRL',
    criterioJulgamento: 'menor-preco',
    agrupamento: 'lote',
    modoDisputa: 'aberto-fechado',
    regimeExecucao: null,
    vigenciaContrato: { meses: 12, prorrogavelAteMeses: null },
    vigenciaAtaRP: null,
    validadeProposta: { dias: 60 },
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
    leisReferenciadas: [
      {
        descricao: 'Lei nº 14.133/2021',
        escopo: 'federal',
        tipoNorma: 'lei',
        numero: '14133',
        ano: 2021,
        contextoNoEdital: 'Regime jurídico do edital',
        revogada: false,
        statusVerificado: 'vigente',
        fonteVerificacao: 'https://www.planalto.gov.br',
      },
    ],
    anexos: [],
    incoerencias: [],
    trechosAmbiguos: [],
    plataforma: 'LICITANET',
    subcontratacaoPermitida: false,
    intervaloMinimoLances: 100,
    prazoRecursosDiasUteis: 3,
    informacoesViabilidade: 'Demandas assistenciais',
    pontosDeAtencao: [],
    fonte: { pdfNativo: false, ocr: false, paginas: 5, url: null },
    ...overrides,
  });
}

const pontosValidos = [
  {
    descricao:
      'Contratação via Sistema de Registro de Preços, sem garantia de consumo integral.',
    categoria: 'operacional',
    severidade: 'media',
    recomendaManifestacao: false,
  },
  {
    descricao: 'Orçamento sigiloso até o encerramento da fase de julgamento.',
    categoria: 'financeiro',
    severidade: 'media',
    recomendaManifestacao: false,
  },
  {
    descricao: 'Vedação à participação em consórcio.',
    categoria: 'competitivo',
    severidade: 'alta',
    recomendaManifestacao: true,
  },
];

/**
 * Minimal fake LanguageModelV2. Returns `payload` (serialized) as text;
 * `generateObject` (JSON mode) parses + validates against the schema.
 */
function fakeModel(payload: unknown) {
  return {
    specificationVersion: 'v2' as const,
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    async doGenerate() {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error('doStream não usado pelo Risk Analyst');
    },
  };
}

describe('montarPrompt — extraction before task order (SPEC §7)', () => {
  it('places the extraction BEFORE the task string (recency)', () => {
    const e = baseExtraction();
    const prompt = montarPrompt(e);

    const idxDoc = prompt.indexOf('"municipio"');
    const idxTarefa = prompt.indexOf(TAREFA);

    expect(idxDoc).toBeGreaterThanOrEqual(0);
    expect(idxTarefa).toBeGreaterThanOrEqual(0);
    expect(idxDoc).toBeLessThan(idxTarefa);
  });

  it('the prompt exposes statusVerificado of the laws (consumption SPEC §4/§5)', () => {
    const e = baseExtraction();
    const prompt = montarPrompt(e);
    expect(prompt).toContain('statusVerificado');
    expect(prompt).toContain('"vigente"');
  });

  it('few-shot stays in the static SYSTEM (cacheable), not in the user prompt', () => {
    const prompt = montarPrompt(baseExtraction());
    expect(SYSTEM_PROMPT).toContain('EXEMPLO');
    expect(prompt).not.toContain('EXEMPLO');
  });
});

describe('GeminiRiskAnalyst — parse/validation (injected model, no network)', () => {
  it('(a) fake with valid points → EditalExtraction with pontosDeAtencao filled and valid', async () => {
    const analyst = new GeminiRiskAnalyst(
      fakeModel({ pontosDeAtencao: pontosValidos }) as never
    );
    const r = await analyst.analisar(baseExtraction());

    expect(r.pontosDeAtencao).toHaveLength(3);
    // The whole result stays valid against the complete schema.
    expect(() => EditalExtractionSchema.parse(r)).not.toThrow();
  });

  it('(b) fake with categoria outside the enum → rejects (throw)', async () => {
    const pontoInvalido = [
      {
        descricao: 'Categoria inexistente.',
        categoria: 'ambiental', // outside {financeiro,operacional,juridico,competitivo}
        severidade: 'alta',
        recomendaManifestacao: true,
      },
    ];
    const analyst = new GeminiRiskAnalyst(
      fakeModel({ pontosDeAtencao: pontoInvalido }) as never
    );

    await expect(analyst.analisar(baseExtraction())).rejects.toThrow();
  });

  it('(c) severidade/categoria/recomendaManifestacao from the fake are preserved in the output', async () => {
    const analyst = new GeminiRiskAnalyst(
      fakeModel({ pontosDeAtencao: pontosValidos }) as never
    );
    const r = await analyst.analisar(baseExtraction());

    expect(r.pontosDeAtencao).toEqual(pontosValidos);
    const consorcio = r.pontosDeAtencao.find((p) =>
      p.descricao.includes('consórcio')
    );
    expect(consorcio?.severidade).toBe('alta');
    expect(consorcio?.categoria).toBe('competitivo');
    expect(consorcio?.recomendaManifestacao).toBe(true);
  });

  it('(d) non-pontosDeAtencao fields of the input extraction are NOT mutated', async () => {
    const entrada = baseExtraction();
    const snapshot = JSON.parse(JSON.stringify({ ...entrada, pontosDeAtencao: undefined }));

    const analyst = new GeminiRiskAnalyst(
      fakeModel({ pontosDeAtencao: pontosValidos }) as never
    );
    const r = await analyst.analisar(entrada);

    // Everything except pontosDeAtencao equals the input snapshot.
    const semPontos = JSON.parse(JSON.stringify({ ...r, pontosDeAtencao: undefined }));
    expect(semPontos).toEqual(snapshot);

    // Specifically: the leis' statusVerificado preserved (consumed, not rewritten).
    expect(r.leisReferenciadas[0].statusVerificado).toBe('vigente');
    expect(r.leisReferenciadas[0].fonteVerificacao).toBe(
      'https://www.planalto.gov.br'
    );

    // The input object was not mutated in-place.
    expect(entrada.pontosDeAtencao).toEqual([]);
  });
});
