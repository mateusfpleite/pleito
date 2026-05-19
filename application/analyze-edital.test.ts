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
 * Testes DETERMINÍSTICOS do workflow `analyzeEdital`. TODOS os ports são
 * MOCKADOS (@superpowers:testing-anti-patterns): aqui se prova ORQUESTRAÇÃO
 * (recomposição, Gate A, Gate B, Tier 0 fatal, propagação de falha) — nunca
 * adapters/LLM. As invariantes:
 *
 *  (a) recomposição: ExtractorOutput SEM pontosDeAtencao vira EditalExtraction
 *      válido (schema) com pontosDeAtencao:[] e `fonte` = a do Preprocessor
 *      (não a que o extractor mock devolveu — carry-forward Phase 5 Minor #2);
 *  (b) Gate A NÃO dispara: nenhuma lei em categoria de risco e nenhum
 *      revogada=true → verifier NÃO chamado;
 *  (c) Gate A dispara por matchNorma mesmo com extractor revogada=false (lei
 *      conhecida revogada, 8.666/1993) → verifier chamado (fecha falso-neg.);
 *  (d) Gate B NÃO dispara: sem incoerência≥média/ambíguo/recomendaManif. →
 *      drafter NÃO chamado, retorna oficio:null;
 *  (e) Gate B dispara só por pontoDeAtencao.recomendaManifestacao → drafter
 *      chamado;
 *  (f) Tier 0 viola (drafter mock devolve ofício afirmando revogação de lei
 *      cujo statusVerificado≠revogada) → analyzeEdital LANÇA (não retorna);
 *  (g) falha de adapter (extractor lança) → propaga (rejeita), não silencia.
 */

const ARQUIVO: ArquivoEntrada = {
  nomeArquivo: 'edital.pdf',
  bytes: new Uint8Array([1, 2, 3]),
  url: 'https://exemplo/edital.pdf',
};

/** FonteMeta confiável que o Preprocessor observa (distinta da do modelo). */
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
 * ExtractorOutput base válido (SEM pontosDeAtencao — schema do extractor).
 * O `fonte` aqui é DELIBERADAMENTE "errado" (mentira do modelo): o workflow
 * deve sobrescrevê-lo pela FonteMeta confiável do Preprocessor.
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
    // MENTIRA do modelo: paginas/url divergem da FonteMeta do Preprocessor.
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
  /** pontosDeAtencao injetados pelo Risk Analyst mock. */
  pontosDeAtencao?: EditalExtraction['pontosDeAtencao'];
  /** mutação extra aplicada pelo verifier mock (ex.: statusVerificado). */
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
  // Verifier mock: por padrão devolve a extração intacta (só Gate A decide
  // se é chamado); pode mutar statusVerificado quando o teste pede.
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

describe('analyzeEdital — recomposição (a)', () => {
  it('monta EditalExtraction válido com pontosDeAtencao:[] e fonte do Preprocessor', async () => {
    // Captura o objeto que chega ao Risk Analyst para inspecionar a
    // recomposição (revogada=true só p/ não importar se Gate A dispara).
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
    // Recomposto satisfaz o EditalExtractionSchema (regressão obrigatória).
    expect(() => EditalExtractionSchema.parse(recomposto)).not.toThrow();
    expect(recomposto.pontosDeAtencao).toEqual([]);
    // fonte = a do Preprocessor (não a mentira do modelo: paginas 42 vs 1).
    expect(recomposto.fonte).toEqual({
      pdfNativo: true,
      ocr: false,
      paginas: 42,
      url: 'https://exemplo/edital.pdf',
    });
  });
});

describe('analyzeEdital — Gate A (b,c)', () => {
  it('(b) NÃO dispara: nenhuma lei de risco e revogada=false → verifier NÃO chamado', async () => {
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

  it('(c) dispara por matchNorma com extractor revogada=false (8.666/1993) → verifier chamado', async () => {
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
      // verifier devolve statusVerificado coerente p/ não acionar Tier 0.
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
  it('(d) NÃO dispara: nada a questionar → drafter NÃO chamado, oficio:null', async () => {
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

  it('(e) dispara só por pontoDeAtencao.recomendaManifestacao → drafter chamado', async () => {
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
  it('ofício afirma revogada p/ lei com statusVerificado≠revogada → LANÇA', async () => {
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
      // verifier devolve a lei como NÃO revogada (nao-verificado default).
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

describe('analyzeEdital — propagação de falha (g)', () => {
  it('extractor lança → analyzeEdital rejeita (não silencia)', async () => {
    const m = makeMocks({
      extrairImpl: async () => {
        throw new Error('Gemini extractor 503');
      },
    });
    await expect(analyzeEdital(ARQUIVO, m.deps)).rejects.toThrow(
      /Gemini extractor 503/
    );
    // pipeline a jusante NÃO roda após a falha.
    expect(m.verificar).not.toHaveBeenCalled();
    expect(m.analisar).not.toHaveBeenCalled();
    expect(m.redigir).not.toHaveBeenCalled();
  });
});
