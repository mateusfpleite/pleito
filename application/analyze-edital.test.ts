import { describe, it, expect, vi } from 'vitest';
import { analyzeEdital } from './analyze-edital.ts';
import type { AnalyzeDeps } from './analyze-edital.ts';
import {
  EditalExtractionSchema,
  ExtractorOutputSchema,
} from '../domain/schema.ts';
import type {
  EditalExtraction,
  ExtractorOutput,
  FonteMeta,
} from '../domain/schema.ts';
import type {
  ArquivoEntrada,
  OficioGerado,
  PreprocessorPort,
  ExtractorPort,
  NormaVerifierPort,
  RiskAnalystPort,
  DrafterPort,
} from '../domain/ports.ts';

/**
 * DETERMINISTIC tests of the `analyzeEdital` workflow. ALL ports are
 * MOCKED (@superpowers:testing-anti-patterns): here we prove ORCHESTRATION
 * (recomposition, Gate A, Gate B, fatal Tier 0, failure propagation) —
 * never adapters/LLM. The invariants:
 *
 *  (a) recomposition: an ExtractorOutput WITHOUT pontosDeAtencao becomes a
 *      valid EditalExtraction (schema) with pontosDeAtencao:[] and `fonte`
 *      = the Preprocessor's (not the one the extractor mock returned —
 *      carry-forward Phase 5 Minor #2);
 *  (b) Gate A does NOT fire: no lei in a risk category and no
 *      revogada=true → verifier NOT called;
 *  (c) Gate A fires via matchNorma even with extractor revogada=false
 *      (known revoked lei, 8.666/1993) → verifier called (closes the
 *      false-neg.);
 *  (d) Gate B does NOT fire: no incoerência≥media/ambiguous/recomendaManif.
 *      → drafter NOT called, returns oficio:null;
 *  (e) Gate B fires only via pontoDeAtencao.recomendaManifestacao →
 *      drafter called;
 *  (f) Tier 0 is violated (drafter mock returns an ofício asserting
 *      revocation of a lei whose statusVerificado≠revogada) → analyzeEdital
 *      THROWS (does not return);
 *  (g) adapter failure (extractor throws) → propagates (rejects), does not
 *      silence.
 */

const ARQUIVO: ArquivoEntrada = {
  nomeArquivo: 'edital.pdf',
  bytes: new Uint8Array([1, 2, 3]),
  url: 'https://exemplo/edital.pdf',
};

/** Trusted FonteMeta the Preprocessor observes (distinct from the model's). */
const FONTE_PREPROCESSOR: FonteMeta = {
  nomeArquivo: 'edital.pdf',
  pdfNativo: true,
  ocr: false,
  paginas: 42,
  url: 'https://exemplo/edital.pdf',
};

function lei(
  over: Partial<EditalExtraction['leisReferenciadas'][number]> = {}
): EditalExtraction['leisReferenciadas'][number] {
  return {
    descricao: 'Lei',
    escopo: 'federal',
    tipoNorma: 'lei',
    numero: null,
    ano: null,
    contextoNoEdital: 'citada no edital',
    revogada: false,
    statusVerificado: 'nao-verificado',
    fonteVerificacao: null,
    ...over,
  };
}

/**
 * Valid base ExtractorOutput (WITHOUT pontosDeAtencao — the extractor's
 * schema). The `fonte` here is DELIBERATELY "wrong" (model lie): the
 * workflow must overwrite it with the Preprocessor's trusted FonteMeta.
 */
function baseExtractorOutput(
  over: Partial<ExtractorOutput> = {}
): ExtractorOutput {
  return ExtractorOutputSchema.parse({
    municipio: 'Jaborandi',
    uf: 'BA',
    ente: {
      tipo: 'prefeitura',
      razaoSocial: 'Prefeitura de Jaborandi',
      cnpj: null,
    },
    modalidade: 'pregao-eletronico',
    numero: '8/2025',
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
    valor: { estimado: 100000, sigiloso: false, procedencia: 'termo-referencia' },
    moeda: 'BRL',
    criterioJulgamento: 'menor-preco',
    agrupamento: 'item',
    modoDisputa: 'aberto',
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
    leisReferenciadas: [lei()],
    anexos: [],
    incoerencias: [],
    trechosAmbiguos: [],
    plataforma: null,
    subcontratacaoPermitida: null,
    intervaloMinimoLances: null,
    prazoRecursosDiasUteis: null,
    informacoesViabilidade: null,
    // Model LIE: paginas/url diverge from the Preprocessor's FonteMeta.
    fonte: { pdfNativo: false, ocr: true, paginas: 1, url: null },
    ...over,
  });
}

type Mocks = {
  deps: AnalyzeDeps;
  preprocessar: ReturnType<typeof vi.fn>;
  extrair: ReturnType<typeof vi.fn>;
  verificar: ReturnType<typeof vi.fn>;
  analisar: ReturnType<typeof vi.fn>;
  redigir: ReturnType<typeof vi.fn>;
};

function makeMocks(opts: {
  extractorOutput?: ExtractorOutput;
  extrairImpl?: () => Promise<ExtractorOutput>;
  /** pontosDeAtencao injected by the Risk Analyst mock. */
  pontosDeAtencao?: EditalExtraction['pontosDeAtencao'];
  /** extra mutation applied by the verifier mock (e.g. statusVerificado). */
  verifierMutate?: (e: EditalExtraction) => EditalExtraction;
  oficio?: OficioGerado | null;
}): Mocks {
  const preprocessar = vi.fn(
    async (): Promise<{ texto: string; fonte: FonteMeta }> => ({
      texto: 'TEXTO PLANO DO EDITAL',
      fonte: FONTE_PREPROCESSOR,
    })
  );
  const extrair = vi.fn(
    opts.extrairImpl ??
      (async () => opts.extractorOutput ?? baseExtractorOutput())
  );
  // Verifier mock: by default returns the extraction intact (only Gate A
  // decides whether it is called); may mutate statusVerificado when the
  // test asks.
  const verificar = vi.fn(async (e: EditalExtraction) =>
    opts.verifierMutate ? opts.verifierMutate(e) : e
  );
  const analisar = vi.fn(async (e: EditalExtraction) => ({
    ...e,
    pontosDeAtencao: opts.pontosDeAtencao ?? [],
  }));
  const redigir = vi.fn(async () => opts.oficio ?? null);

  const deps: AnalyzeDeps = {
    preprocessor: { preprocessar } as PreprocessorPort,
    extractor: { extrair } as ExtractorPort,
    normaVerifier: { verificar } as NormaVerifierPort,
    riskAnalyst: { analisar } as RiskAnalystPort,
    drafter: { redigir } as DrafterPort,
  };
  return { deps, preprocessar, extrair, verificar, analisar, redigir };
}

describe('analyzeEdital — recomposition (a)', () => {
  it('builds a valid EditalExtraction with pontosDeAtencao:[] and Preprocessor fonte', async () => {
    // Captures the object that reaches the Risk Analyst to inspect the
    // recomposition (revogada=true just so it does not matter whether
    // Gate A fires).
    const out = makeMocks({
      extractorOutput: baseExtractorOutput({
        leisReferenciadas: [lei({ numero: '999', ano: 2030, revogada: true })],
      }),
    });
    let recibidoPeloRisk: EditalExtraction | null = null;
    out.analisar.mockImplementation(async (e: EditalExtraction) => {
      recibidoPeloRisk = e;
      return { ...e, pontosDeAtencao: [] };
    });

    await analyzeEdital(ARQUIVO, out.deps);

    expect(recibidoPeloRisk).not.toBeNull();
    const recomposto = recibidoPeloRisk as unknown as EditalExtraction;
    // The recomposed object satisfies EditalExtractionSchema (mandatory regression).
    expect(() => EditalExtractionSchema.parse(recomposto)).not.toThrow();
    expect(recomposto.pontosDeAtencao).toEqual([]);
    // fonte = the Preprocessor's (not the model lie: paginas 42 vs 1).
    expect(recomposto.fonte).toEqual({
      pdfNativo: true,
      ocr: false,
      paginas: 42,
      url: 'https://exemplo/edital.pdf',
    });
  });
});

describe('analyzeEdital — Gate A (b,c)', () => {
  it('(b) does NOT fire: no risky law and revogada=false → verifier NOT called', async () => {
    const m = makeMocks({
      extractorOutput: baseExtractorOutput({
        leisReferenciadas: [
          lei({ numero: '14.133', ano: 2021, revogada: false }),
        ],
      }),
    });
    await analyzeEdital(ARQUIVO, m.deps);
    expect(m.verificar).not.toHaveBeenCalled();
  });

  it('(c) fires via matchNorma with extractor revogada=false (8.666/1993) → verifier called', async () => {
    const m = makeMocks({
      extractorOutput: baseExtractorOutput({
        leisReferenciadas: [
          lei({
            numero: '8.666',
            ano: 1993,
            escopo: 'federal',
            tipoNorma: 'lei',
            revogada: false,
          }),
        ],
      }),
      // verifier returns a consistent statusVerificado so Tier 0 is not triggered.
      verifierMutate: (e) => ({
        ...e,
        leisReferenciadas: e.leisReferenciadas.map((l) => ({
          ...l,
          statusVerificado: 'revogada' as const,
        })),
      }),
    });
    await analyzeEdital(ARQUIVO, m.deps);
    expect(m.verificar).toHaveBeenCalledTimes(1);
  });
});

describe('analyzeEdital — Gate B (d,e)', () => {
  it('(d) does NOT fire: nothing to question → drafter NOT called, oficio:null', async () => {
    const m = makeMocks({
      extractorOutput: baseExtractorOutput({
        incoerencias: [
          { tipo: 'outro', descricao: 'menor', severidade: 'baixa' },
        ],
      }),
      pontosDeAtencao: [
        {
          descricao: 'ponto informativo',
          categoria: 'operacional',
          severidade: 'baixa',
          recomendaManifestacao: false,
        },
      ],
    });
    const res = await analyzeEdital(ARQUIVO, m.deps);
    expect(m.redigir).not.toHaveBeenCalled();
    expect(res.oficio).toBeNull();
  });

  it('(e) fires only via pontoDeAtencao.recomendaManifestacao → drafter called', async () => {
    const m = makeMocks({
      pontosDeAtencao: [
        {
          descricao: 'exige manifestação',
          categoria: 'juridico',
          severidade: 'baixa',
          recomendaManifestacao: true,
        },
      ],
      oficio: {
        tipo: 'esclarecimento',
        markdown: 'Solicita-se esclarecimento.',
        leisCitadas: [],
      },
    });
    const res = await analyzeEdital(ARQUIVO, m.deps);
    expect(m.redigir).toHaveBeenCalledTimes(1);
    expect(res.oficio).not.toBeNull();
  });
});

describe('analyzeEdital — Tier 0 fatal (f)', () => {
  it('ofício asserts revogada for a law with statusVerificado≠revogada → THROWS', async () => {
    const m = makeMocks({
      extractorOutput: baseExtractorOutput({
        leisReferenciadas: [
          lei({ numero: '7.777', ano: 2010, revogada: true }),
        ],
      }),
      pontosDeAtencao: [
        {
          descricao: 'exige manifestação',
          categoria: 'juridico',
          severidade: 'alta',
          recomendaManifestacao: true,
        },
      ],
      // verifier returns the lei as NOT revoked (nao-verificado default).
      oficio: {
        tipo: 'impugnacao',
        markdown: 'A norma foi revogada.',
        leisCitadas: [
          { numero: '7.777', ano: 2010, afirmacaoVigencia: 'revogada' },
        ],
      },
    });
    await expect(analyzeEdital(ARQUIVO, m.deps)).rejects.toThrow(
      /Tier 0|contenção|viola/i
    );
  });
});

describe('analyzeEdital — failure propagation (g)', () => {
  it('extractor throws → analyzeEdital rejects (does not silence)', async () => {
    const m = makeMocks({
      extrairImpl: async () => {
        throw new Error('Gemini extractor 503');
      },
    });
    await expect(analyzeEdital(ARQUIVO, m.deps)).rejects.toThrow(
      /Gemini extractor 503/
    );
    // the downstream pipeline does NOT run after the failure.
    expect(m.verificar).not.toHaveBeenCalled();
    expect(m.analisar).not.toHaveBeenCalled();
    expect(m.redigir).not.toHaveBeenCalled();
  });
});
