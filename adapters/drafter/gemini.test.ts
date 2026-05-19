import { describe, it, expect } from 'vitest';
import { GeminiDrafter } from './gemini.ts';
import { montarPrompt, TAREFA, SYSTEM_PROMPT } from './prompt.ts';
import { EditalExtractionSchema } from '../../domain/schema.ts';
import type { EditalExtraction } from '../../domain/schema.ts';

/**
 * Testes DETERMINÍSTICOS do Drafter (contenção ESTRUTURAL §5 #2). O
 * LanguageModel é mocado — NUNCA chamamos o Gemini real nem testamos "o LLM
 * retornou X" (@superpowers:testing-anti-patterns). As invariantes provadas
 * são propriedades do ADAPTER (montagem determinística), não do modelo.
 *
 * REDESIGN (contenção estrutural, não confiar em prosa livre do modelo): o
 * modelo NÃO escreve mais o markdown. Ele produz, por ponto a questionar,
 * apenas `{titulo, argumento}` (a divergência factual + o questionamento) e a
 * lista `leisCitadas` com `afirmacaoVigencia`. O MARKDOWN final é montado
 * DETERMINISTICAMENTE pelo adapter: afirmações de (não)vigência são SEMPRE
 * frases-template keyed pelo `statusVerificado` verificado — o modelo nunca
 * escreve frase de vigência. Logo C1 (vazamento de revogação em prosa livre)
 * é estruturalmente impossível.
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
 *  (e) `tipo` ∈ enum e markdown não-vazio quando não-null;
 *  (C1) campos estruturados TODOS corretos mas argumento do ponto contém
 *      "a IN 05/2017 perdeu vigência" → backstop léxico rebaixa o ponto;
 *      única frase de vigência permitida = template da 8666 revogada;
 *  (C2) duas leis mesmo numero/ano (uma revogada, uma contestada) →
 *      lookup ambíguo NUNCA afirma revogação; `numero:null` idem;
 *  (I1) incoerência `lei-revogada` com "revogada" na descrição → ofício
 *      neutro NÃO contém `/revogad/i` (escrubado por categoria);
 *  (I2) incoerência só `severidade:'baixa'` → `redigir` retorna `null`.
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

/** Léxico de (não)vigência — qualquer um destes na prosa final sobre uma lei
 * NÃO verificada-revogada é vazamento catastrófico. */
const LEXICO_VIGENCIA =
  /revogad|perdeu vig[êe]ncia|n[ãa]o est[áa] mais em vigor|deixou de viger|sem vig[êe]ncia|caducou/i;

describe('GeminiDrafter — contenção estrutural (model injetado, sem rede)', () => {
  it('(a) lei contestada + fake tenta revogada → adapter FORÇA nenhuma e não afirma revogação', async () => {
    const e = baseExtraction({
      leisReferenciadas: [leiContestada],
      pontosDeAtencao: [pontoManifesta],
    });
    // O modelo (fake) tenta vazar uma afirmação de revogação de lei NÃO
    // verificada como revogada — exatamente o dano catastrófico que o guard
    // deve conter. Aqui o vazamento vem no `argumento` do ponto (o modelo não
    // escreve mais markdown livre).
    const drafter = new GeminiDrafter(
      fakeModel({
        tipo: 'esclarecimento',
        pontos: [
          {
            titulo: 'Habilitação técnica',
            argumento:
              'A Instrução Normativa SEGES nº 05/2017 encontra-se revogada ' +
              'e não pode embasar a habilitação.',
          },
        ],
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

    // A prosa final, montada deterministicamente, não pode afirmar
    // revogação dessa lei: o backstop léxico descarta o argumento vazante.
    expect(o.markdown).not.toMatch(LEXICO_VIGENCIA);
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
        pontos: [
          {
            titulo: 'Fundamento legal do certame',
            argumento:
              'O edital indica como base jurídica norma cuja vigência é o ' +
              'ponto a esclarecer.',
          },
        ],
        leisCitadas: [
          { numero: '8666', ano: 1993, afirmacaoVigencia: 'revogada' },
        ],
      }) as never
    );

    const oficio = await drafter.redigir(e);
    expect(oficio).not.toBeNull();
    const lei = oficio!.leisCitadas.find((l) => l.numero === '8666');
    expect(lei!.afirmacaoVigencia).toBe('revogada');
    // A frase de revogação É permitida — mas vem do TEMPLATE do adapter
    // (keyed pelo statusVerificado), não da prosa livre do modelo.
    expect(oficio!.markdown).toMatch(/encontra-se revogada/i);
    expect(oficio!.markdown).toMatch(/norma-baseline\.json/);
  });

  it('(c) sem incoerências/ambíguos/manifestação → retorna null (gate B não dispara)', async () => {
    const e = baseExtraction(); // tudo vazio
    // Mesmo que o modelo proponha um ofício, não há gatilho: adapter nem
    // chama o modelo e devolve null.
    const drafter = new GeminiDrafter(
      fakeModel({ tipo: 'esclarecimento', pontos: [], leisCitadas: [] }) as never
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
        pontos: [
          { titulo: 'Base legal', argumento: 'Questiona-se a base legal.' },
        ],
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
        pontos: [
          {
            titulo: 'Vedação a consórcio',
            argumento: 'Impugna-se a vedação a consórcio.',
          },
        ],
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
        pontos: [
          {
            titulo: 'Norma aplicável',
            argumento: 'Solicita-se esclarecimento.',
          },
        ],
        leisCitadas: [
          { numero: '14133', ano: 2021, afirmacaoVigencia: 'vigente' },
        ],
      }) as never
    );
    const oficio = await drafter.redigir(e);
    // Não há por que afirmar vigência proativamente: guard força 'nenhuma'.
    const lei = oficio!.leisCitadas.find((l) => l.numero === '14133');
    expect(lei!.afirmacaoVigencia).toBe('nenhuma');
    // E nenhuma frase de vigência vaza para o markdown.
    expect(oficio!.markdown).not.toMatch(LEXICO_VIGENCIA);
  });
});

describe('GeminiDrafter — adversarial (C1/C2/I1/I2): contenção ESTRUTURAL', () => {
  it('(C1) campos estruturados TODOS corretos mas argumento difama lei contestada em prosa → backstop léxico rebaixa o ponto; só a 8666 (genuinamente revogada) tem frase de vigência', async () => {
    // 8666/1993 genuinamente revogada; IN 05/2017 contestada (zona-cinzenta).
    const e = baseExtraction({
      leisReferenciadas: [leiRevogada, leiContestada],
      incoerencias: [
        {
          tipo: 'lei-revogada',
          descricao: 'Edital cita norma cujo regime jurídico se questiona.',
          severidade: 'alta',
        },
      ],
    });
    // Campos estruturados PERFEITOS — o guard não rebaixa nada. Mas o
    // argumento do ponto difama a 5/2017 em prosa livre, enquanto cita
    // legitimamente a 8666 revogada (cenário onde o scan léxico de markdown
    // livre não consegue desambiguar por-lei).
    const drafter = new GeminiDrafter(
      fakeModel({
        tipo: 'esclarecimento',
        pontos: [
          {
            titulo: 'Regime jurídico',
            argumento:
              'A Lei 8.666/93 está revogada; ademais a IN 05/2017 ' +
              'igualmente perdeu vigência e não pode reger a habilitação.',
          },
        ],
        leisCitadas: [
          { numero: '8666', ano: 1993, afirmacaoVigencia: 'revogada' },
          { numero: '5', ano: 2017, afirmacaoVigencia: 'nenhuma' },
        ],
      }) as never
    );

    const oficio = await drafter.redigir(e);
    expect(oficio).not.toBeNull();
    const md = oficio!.markdown;

    // Campos estruturados ficam corretos (guard não rebaixou):
    expect(
      oficio!.leisCitadas.find((l) => l.numero === '8666')!.afirmacaoVigencia
    ).toBe('revogada');
    expect(
      oficio!.leisCitadas.find((l) => l.numero === '5')!.afirmacaoVigencia
    ).toBe('nenhuma');

    // O argumento difamatório do modelo NÃO pode aparecer no markdown final
    // (backstop léxico rebaixa o ponto para fraseado-pergunta neutro).
    expect(md).not.toContain('perdeu vigência');
    expect(md).not.toContain('IN 05/2017 igualmente');

    // A ÚNICA frase de (não)vigência permitida no ofício é a TEMPLATE da
    // 8666 genuinamente revogada (statusVerificado='revogada'). Não pode
    // haver QUALQUER léxico de revogação associado à 5/2017.
    const ocorrencias = md.match(/revogad[ao]/gi) ?? [];
    // Apenas a frase-template da 8666 (1 menção de "revogada").
    expect(ocorrencias.length).toBeGreaterThanOrEqual(1);
    expect(md).toMatch(/8\.?666[\s\S]*encontra-se revogada/i);
    // Nenhuma frase de vigência ligada à 05/2017:
    expect(md).not.toMatch(/05\/?2017[^.]*?(revogad|perdeu vig|sem vig)/i);
    expect(md).not.toMatch(/(revogad|perdeu vig|sem vig)[^.]*?05\/?2017/i);
  });

  it('(C2) duas leis mesmo numero/ano (uma revogada, uma contestada) → lookup ambíguo NUNCA afirma revogação', async () => {
    const leiDup1 = { ...leiRevogada, descricao: 'Lei X (a)', numero: '777', ano: 2000, statusVerificado: 'revogada' as const };
    const leiDup2 = { ...leiContestada, descricao: 'Lei X (b)', numero: '777', ano: 2000, statusVerificado: 'contestada' as const };
    const e = baseExtraction({
      leisReferenciadas: [leiDup1, leiDup2],
      pontosDeAtencao: [pontoManifesta],
    });
    const drafter = new GeminiDrafter(
      fakeModel({
        tipo: 'esclarecimento',
        pontos: [
          { titulo: 'Norma', argumento: 'Questiona-se a norma invocada.' },
        ],
        // Modelo tenta afirmar revogação da chave ambígua.
        leisCitadas: [
          { numero: '777', ano: 2000, afirmacaoVigencia: 'revogada' },
        ],
      }) as never
    );

    const oficio = await drafter.redigir(e);
    expect(oficio).not.toBeNull();
    // Chave não-única → não dá pra atribuir com segurança → nenhuma/neutro.
    const lei = oficio!.leisCitadas.find((l) => l.numero === '777');
    expect(lei!.afirmacaoVigencia).toBe('nenhuma');
    expect(oficio!.markdown).not.toMatch(LEXICO_VIGENCIA);
  });

  it('(C2) numero:null nunca é match confiável → nunca afirma revogação', async () => {
    const leiSemNumero = {
      ...leiRevogada,
      descricao: 'Norma sem número identificável',
      numero: null,
      ano: null,
      statusVerificado: 'revogada' as const,
    };
    const e = baseExtraction({
      leisReferenciadas: [leiSemNumero],
      pontosDeAtencao: [pontoManifesta],
    });
    const drafter = new GeminiDrafter(
      fakeModel({
        tipo: 'esclarecimento',
        pontos: [{ titulo: 'Norma', argumento: 'Questiona-se a norma.' }],
        leisCitadas: [
          { numero: null, ano: null, afirmacaoVigencia: 'revogada' },
        ],
      }) as never
    );

    const oficio = await drafter.redigir(e);
    expect(oficio).not.toBeNull();
    const lei = oficio!.leisCitadas.find((l) => l.numero === null);
    expect(lei!.afirmacaoVigencia).toBe('nenhuma');
    expect(oficio!.markdown).not.toMatch(LEXICO_VIGENCIA);
  });

  it('(I1) incoerência lei-revogada com "revogada" na descrição + modelo rebaixado → ofício neutro NÃO contém /revogad/i', async () => {
    // Cenário onde o guard rebaixa (lei contestada, modelo tentou revogada) →
    // ofício neutro determinístico. A incoerência traz "revogada" na
    // descrição (texto LLM a montante). O ofício neutro deve ser provadamente
    // sem léxico de vigência.
    const e = baseExtraction({
      leisReferenciadas: [leiContestada],
      incoerencias: [
        {
          tipo: 'lei-revogada',
          descricao: 'A Lei 8.666/93 foi revogada pela 14.133.',
          severidade: 'alta',
        },
      ],
      trechosAmbiguos: [
        {
          trechoLiteral: 'a norma deixou de viger',
          porQueAmbiguo: 'A redação sugere que a norma perdeu vigência.',
          secaoOndeAparece: 'item 7',
        },
      ],
    });
    const drafter = new GeminiDrafter(
      fakeModel({
        tipo: 'esclarecimento',
        pontos: [{ titulo: 'X', argumento: 'Y' }],
        // Modelo tenta revogada numa lei contestada → guard rebaixa →
        // ofício neutro determinístico.
        leisCitadas: [
          { numero: '5', ano: 2017, afirmacaoVigencia: 'revogada' },
        ],
      }) as never
    );

    const oficio = await drafter.redigir(e);
    expect(oficio).not.toBeNull();
    // Ofício neutro: NENHUM léxico de (não)vigência (escrubado por categoria).
    expect(oficio!.markdown).not.toMatch(LEXICO_VIGENCIA);
    expect(oficio!.markdown).not.toMatch(/revogad/i);
    expect(oficio!.markdown).toMatch(/solicita-se esclarecimento/i);
  });

  it('(I2) incoerência só severidade:baixa, nada mais → redigir retorna null (gate B não dispara)', async () => {
    const e = baseExtraction({
      incoerencias: [
        {
          tipo: 'outro',
          descricao: 'Pequena divergência de formatação.',
          severidade: 'baixa',
        },
      ],
    });
    const drafter = new GeminiDrafter(
      fakeModel({ tipo: 'esclarecimento', pontos: [], leisCitadas: [] }) as never
    );
    const oficio = await drafter.redigir(e);
    expect(oficio).toBeNull();
  });

  it('(I2) incoerência severidade:media → gate B dispara (não-null)', async () => {
    const e = baseExtraction({
      incoerencias: [
        {
          tipo: 'valor-divergente',
          descricao: 'Valor da capa diverge do termo de referência.',
          severidade: 'media',
        },
      ],
    });
    const drafter = new GeminiDrafter(
      fakeModel({
        tipo: 'esclarecimento',
        pontos: [{ titulo: 'Valor', argumento: 'Há divergência de valor.' }],
        leisCitadas: [],
      }) as never
    );
    const oficio = await drafter.redigir(e);
    expect(oficio).not.toBeNull();
  });
});
