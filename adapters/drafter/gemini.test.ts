import { describe, it, expect } from 'vitest';
import { GeminiDrafter } from './gemini.ts';
import { montarPrompt, TAREFA, SYSTEM_PROMPT } from './prompt.ts';
import { EditalExtractionSchema } from '../../domain/schema.ts';
import type { EditalExtraction } from '../../domain/schema.ts';

/**
 * Testes DETERMINÍSTICOS do Drafter (contenção estrutural §5 #2). O
 * LanguageModel é mocado — NUNCA chamamos o Gemini real nem testamos "o LLM
 * retornou X" (@superpowers:testing-anti-patterns). As invariantes provadas
 * são propriedades do ADAPTER (guard determinístico), não do modelo:
 *
 *  (montagem) o prompt põe a EXTRAÇÃO antes da string de TAREFA (recência
 *      long-context, SPEC §7); few-shot Pariconha vive no SYSTEM (cacheável);
 *  (a) lei `statusVerificado='contestada'` + fake tenta
 *      `afirmacaoVigencia='revogada'` → o adapter FORÇA para 'nenhuma'
 *      (guard determinístico, defense in depth) e o markdown, sobre essa
 *      lei, não pode afirmar revogação — deve perguntar ao órgão;
 *  (b) lei `statusVerificado='revogada'` + fake `afirmacaoVigencia='revogada'`
 *      → permitido (mantém 'revogada');
 *  (c) extração SEM incoerências/trechos ambíguos/pontos que recomendem
 *      manifestação → adapter retorna `null` (gate B não dispara);
 *  (d) `leisCitadas` é sempre subconjunto de `e.leisReferenciadas` (o
 *      adapter descarta qualquer lei inventada pelo modelo);
 *  (e) `tipo` ∈ enum e markdown não-vazio quando não-null.
 *
 * O mock implementa só a superfície de `generateObject` que o adapter usa:
 * `doGenerate` devolve o JSON proposto pelo modelo em `content`.
 */

/** Extração base válida; cada teste injeta leis/incoerências/pontos. */
function baseExtraction(
  overrides: Partial<EditalExtraction> = {}
): EditalExtraction {
  return EditalExtractionSchema.parse({
    municipio: 'Pariconha',
    uf: 'AL',
    ente: {
      tipo: 'prefeitura',
      razaoSocial: 'Prefeitura Municipal de Pariconha',
      cnpj: null,
    },
    modalidade: 'pregao-eletronico',
    numero: '008/2026',
    processoAdministrativo: null,
    dataPublicacao: null,
    dataSessao: null,
    uasg: null,
    regimeJuridico: 'lei-14133',
    objetoCorpo: 'Serviços funerários completos',
    objetoCapa: null,
    objetoSummary: 'Serviços funerários',
    tipoObjeto: ['servicos-funerarios-completos'],
    secretariaDemandante: null,
    valor: { estimado: 200000, sigiloso: false, procedencia: 'termo-referencia' },
    moeda: 'BRL',
    criterioJulgamento: 'menor-preco',
    agrupamento: 'lote',
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
    leisReferenciadas: [],
    anexos: [],
    incoerencias: [],
    trechosAmbiguos: [],
    plataforma: 'LICITANET',
    subcontratacaoPermitida: false,
    intervaloMinimoLances: 100,
    prazoRecursosDiasUteis: 3,
    informacoesViabilidade: null,
    pontosDeAtencao: [],
    fonte: { pdfNativo: false, ocr: false, paginas: 5, url: null },
    ...overrides,
  });
}

/** Lei revogada e verificada (path do teste (b)). */
const leiRevogada = {
  descricao: 'Lei nº 8.666/1993',
  escopo: 'federal' as const,
  tipoNorma: 'lei' as const,
  numero: '8666',
  ano: 1993,
  contextoNoEdital: 'Regime jurídico citado no preâmbulo',
  revogada: true,
  statusVerificado: 'revogada' as const,
  fonteVerificacao: 'norma-baseline.json',
};

/** Lei em zona-cinzenta (contestada): NÃO pode virar afirmação no ofício. */
const leiContestada = {
  descricao: 'Instrução Normativa SEGES nº 05/2017',
  escopo: 'federal' as const,
  tipoNorma: 'instrucao-normativa' as const,
  numero: '5',
  ano: 2017,
  contextoNoEdital: 'Critérios de habilitação técnica',
  revogada: false,
  statusVerificado: 'contestada' as const,
  fonteVerificacao: 'norma-baseline.json',
};

/** Um ponto que recomenda manifestação → gate B dispara. */
const pontoManifesta = {
  descricao: 'Vedação à participação em consórcio sem justificativa técnica.',
  categoria: 'competitivo' as const,
  severidade: 'alta' as const,
  recomendaManifestacao: true,
};

/**
 * LanguageModelV2 fake mínimo. Devolve `payload` (serializado) como texto;
 * `generateObject` (modo JSON) faz parse + valida contra o schema.
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
      throw new Error('doStream não usado pelo Drafter');
    },
  };
}

describe('montarPrompt — ordem extração antes da tarefa (SPEC §7)', () => {
  it('põe a extração ANTES da string de tarefa (recência)', () => {
    const prompt = montarPrompt(baseExtraction({ incoerencias: [] }));
    const idxDoc = prompt.indexOf('"municipio"');
    const idxTarefa = prompt.indexOf(TAREFA);
    expect(idxDoc).toBeGreaterThanOrEqual(0);
    expect(idxTarefa).toBeGreaterThanOrEqual(0);
    expect(idxDoc).toBeLessThan(idxTarefa);
  });

  it('few-shot Pariconha fica no SYSTEM estático, não no prompt do user', () => {
    const prompt = montarPrompt(baseExtraction());
    expect(SYSTEM_PROMPT).toMatch(/pariconha/i);
    expect(SYSTEM_PROMPT).toContain('OFÍCIO DE ESCLARECIMENTO');
    expect(prompt).not.toContain('OFÍCIO DE ESCLARECIMENTO');
  });

  it('o SYSTEM ensina a regra de contenção decide→escreve', () => {
    expect(SYSTEM_PROMPT).toMatch(/afirmacaoVigencia/);
    expect(SYSTEM_PROMPT).toMatch(/solicita-se (confirmação|esclarecimento)/i);
  });
});

describe('GeminiDrafter — contenção estrutural (model injetado, sem rede)', () => {
  it('(a) lei contestada + fake tenta revogada → adapter FORÇA nenhuma e não afirma revogação', async () => {
    const e = baseExtraction({
      leisReferenciadas: [leiContestada],
      pontosDeAtencao: [pontoManifesta],
    });
    // O modelo (fake) tenta vazar uma afirmação de revogação de lei NÃO
    // verificada como revogada — exatamente o dano catastrófico que o guard
    // deve conter.
    const drafter = new GeminiDrafter(
      fakeModel({
        tipo: 'esclarecimento',
        markdown:
          '## OFÍCIO DE ESCLARECIMENTO\n\nA Instrução Normativa SEGES nº ' +
          '05/2017 encontra-se revogada e não pode embasar a habilitação.',
        leisCitadas: [
          { numero: '5', ano: 2017, afirmacaoVigencia: 'revogada' },
        ],
      }) as never
    );

    const oficio = await drafter.redigir(e);
    expect(oficio).not.toBeNull();
    const o = oficio!;

    // Guard determinístico: statusVerificado != 'revogada' → forçado a 'nenhuma'.
    const lei = o.leisCitadas.find((l) => l.numero === '5' && l.ano === 2017);
    expect(lei).toBeDefined();
    expect(lei!.afirmacaoVigencia).toBe('nenhuma');
    expect(
      o.leisCitadas.every((l) => l.afirmacaoVigencia !== 'revogada')
    ).toBe(true);

    // A prosa, sobre essa lei, não pode afirmar revogação: o adapter
    // substitui o markdown do modelo por prosa neutra de QUESTIONAMENTO
    // quando há divergência guard×modelo (defense in depth na prosa).
    expect(o.markdown).not.toMatch(/revogad/i);
    expect(o.markdown).toMatch(/solicita-se (confirmação|esclarecimento)/i);
  });

  it('(b) lei revogada verificada → afirmacaoVigencia="revogada" permitido', async () => {
    const e = baseExtraction({
      leisReferenciadas: [leiRevogada],
      incoerencias: [
        {
          tipo: 'lei-revogada',
          descricao: 'Edital cita a Lei 8.666/1993, revogada pela Lei 14.133/2021.',
          severidade: 'alta',
        },
      ],
    });
    const drafter = new GeminiDrafter(
      fakeModel({
        tipo: 'esclarecimento',
        markdown:
          '## OFÍCIO DE ESCLARECIMENTO\n\nO edital fundamenta-se na Lei nº ' +
          '8.666/1993, revogada pela Lei nº 14.133/2021.',
        leisCitadas: [
          { numero: '8666', ano: 1993, afirmacaoVigencia: 'revogada' },
        ],
      }) as never
    );

    const oficio = await drafter.redigir(e);
    expect(oficio).not.toBeNull();
    const lei = oficio!.leisCitadas.find((l) => l.numero === '8666');
    expect(lei!.afirmacaoVigencia).toBe('revogada');
  });

  it('(c) sem incoerências/ambíguos/manifestação → retorna null (gate B não dispara)', async () => {
    const e = baseExtraction(); // tudo vazio
    // Mesmo que o modelo proponha um ofício, não há gatilho: adapter nem
    // chama o modelo e devolve null.
    const drafter = new GeminiDrafter(
      fakeModel({ tipo: 'esclarecimento', markdown: 'x', leisCitadas: [] }) as never
    );
    const oficio = await drafter.redigir(e);
    expect(oficio).toBeNull();
  });

  it('(d) leisCitadas é subconjunto de leisReferenciadas (descarta lei inventada)', async () => {
    const e = baseExtraction({
      leisReferenciadas: [leiRevogada],
      incoerencias: [
        {
          tipo: 'lei-revogada',
          descricao: 'Lei 8.666/1993 revogada.',
          severidade: 'alta',
        },
      ],
    });
    const drafter = new GeminiDrafter(
      fakeModel({
        tipo: 'esclarecimento',
        markdown: '## OFÍCIO DE ESCLARECIMENTO\n\nQuestiona-se a base legal.',
        leisCitadas: [
          { numero: '8666', ano: 1993, afirmacaoVigencia: 'revogada' },
          // Lei inventada (não está em leisReferenciadas) — deve ser descartada.
          { numero: '99999', ano: 2099, afirmacaoVigencia: 'revogada' },
        ],
      }) as never
    );

    const oficio = await drafter.redigir(e);
    expect(oficio).not.toBeNull();
    const numeros = oficio!.leisCitadas.map((l) => l.numero);
    expect(numeros).toContain('8666');
    expect(numeros).not.toContain('99999');
    // Subconjunto estrito de leisReferenciadas.
    for (const l of oficio!.leisCitadas) {
      expect(
        e.leisReferenciadas.some(
          (r) => r.numero === l.numero && r.ano === l.ano
        )
      ).toBe(true);
    }
  });

  it('(e) tipo ∈ enum e markdown não-vazio quando não-null', async () => {
    const e = baseExtraction({
      pontosDeAtencao: [pontoManifesta],
      leisReferenciadas: [leiContestada],
    });
    const drafter = new GeminiDrafter(
      fakeModel({
        tipo: 'impugnacao',
        markdown:
          '## OFÍCIO DE IMPUGNAÇÃO\n\nImpugna-se a vedação a consórcio.',
        leisCitadas: [
          { numero: '5', ano: 2017, afirmacaoVigencia: 'nenhuma' },
        ],
      }) as never
    );
    const oficio = await drafter.redigir(e);
    expect(oficio).not.toBeNull();
    expect(['esclarecimento', 'impugnacao']).toContain(oficio!.tipo);
    expect(oficio!.markdown.trim().length).toBeGreaterThan(0);
  });

  it('(b2) modelo tenta forçar "vigente" em lei vigente → adapter normaliza para "nenhuma"', async () => {
    const leiVigente = {
      ...leiRevogada,
      descricao: 'Lei nº 14.133/2021',
      numero: '14133',
      ano: 2021,
      revogada: false,
      statusVerificado: 'vigente' as const,
    };
    const e = baseExtraction({
      leisReferenciadas: [leiVigente],
      pontosDeAtencao: [pontoManifesta],
    });
    const drafter = new GeminiDrafter(
      fakeModel({
        tipo: 'esclarecimento',
        markdown: '## OFÍCIO DE ESCLARECIMENTO\n\nSolicita-se esclarecimento.',
        leisCitadas: [
          { numero: '14133', ano: 2021, afirmacaoVigencia: 'vigente' },
        ],
      }) as never
    );
    const oficio = await drafter.redigir(e);
    // Não há por que afirmar vigência proativamente: guard força 'nenhuma'.
    const lei = oficio!.leisCitadas.find((l) => l.numero === '14133');
    expect(lei!.afirmacaoVigencia).toBe('nenhuma');
  });
});
