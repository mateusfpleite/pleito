import { describe, it, expect } from 'vitest';
import { GeminiDrafter } from './gemini.ts';
import { montarPrompt, TAREFA, SYSTEM_PROMPT } from './prompt.ts';
import { EditalExtractionSchema } from '../../domain/schema.ts';
import type { EditalExtraction } from '../../domain/schema.ts';

/**
 * Testes ADVERSARIAIS DETERMINÍSTICOS do Drafter (contenção ESTRUTURAL REAL,
 * SPEC §5 #2). O LanguageModel é mocado — NUNCA chamamos o Gemini real nem
 * testamos "o LLM retornou X" (@superpowers:testing-anti-patterns). As
 * invariantes provadas são propriedades do ADAPTER.
 *
 * CONTRATO NOVO (ZERO prosa livre do modelo no ofício externo):
 *   O modelo emite SOMENTE decisões estruturadas:
 *     - `tipo` ∈ {esclarecimento, impugnacao};
 *     - `selecoes[]`: cada uma referencia um achado JÁ EXISTENTE na extração
 *       por `{fonte∈{incoerencia,trechoAmbiguo,pontoDeAtencao}, indice}` —
 *       i.e. o modelo escolhe O QUE levantar e a ORDEM, não REDIGE;
 *     - `leisCitadas[]` com `afirmacaoVigencia` (já estrutural).
 *   NÃO HÁ MAIS campo de texto livre (`pontos[].argumento`/`titulo`). O corpo
 *   do ofício é montado 100% por TEMPLATES determinísticos keyed pelo TIPO
 *   estruturado do achado. Por isso "ab-rogada"/"não subsiste"/etc. são
 *   ESTRUTURALMENTE IMPOSSÍVEIS de aparecer — não há canal por onde o modelo
 *   escreva esse texto, não é "filtrado".
 *
 * O backstop léxico (LEXICO_VIGENCIA) é TRIPWIRE defensivo: se disparar, é
 * bug estrutural. A garantia é a AUSÊNCIA de prosa livre, não o regex.
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

/** Lei revogada e verificada. */
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

  it('o SYSTEM ensina que o modelo NÃO redige (só seleciona achados)', () => {
    expect(SYSTEM_PROMPT).toMatch(/afirmacaoVigencia/);
    expect(SYSTEM_PROMPT).toMatch(/selecoes/);
    // O contrato proíbe explicitamente texto livre.
    expect(SYSTEM_PROMPT).toMatch(/N[ÃA]O escreve|n[ãa]o redige|sem prosa/i);
  });
});

/**
 * Tripwire léxico (NÃO é a garantia; se disparar é bug estrutural). Inclui as
 * paráfrases que vazaram em produção e mais.
 */
const LEXICO_VIGENCIA =
  /revogad|ab-?rogad|derrogad|revogou-se|perdeu vig[êe]ncia|n[ãa]o subsiste|superad|exaurid|deixou de produzir efeitos|n[ãa]o vige|sem efic[áa]cia|n[ãa]o est[áa] (mais )?em vigor|deixou de viger|sem vig[êe]ncia|caducou/i;

describe('GeminiDrafter — contenção estrutural REAL (model injetado, sem rede)', () => {
  it('(a) lei contestada + fake tenta revogada → adapter FORÇA nenhuma; markdown não afirma revogação', async () => {
    const e = baseExtraction({
      leisReferenciadas: [leiContestada],
      pontosDeAtencao: [pontoManifesta],
    });
    const drafter = new GeminiDrafter(
      fakeModel({
        tipo: 'esclarecimento',
        selecoes: [{ fonte: 'pontoDeAtencao', indice: 0 }],
        leisCitadas: [
          { numero: '5', ano: 2017, afirmacaoVigencia: 'revogada' },
        ],
      }) as never
    );

    const oficio = await drafter.redigir(e);
    expect(oficio).not.toBeNull();
    const o = oficio!;

    const lei = o.leisCitadas.find((l) => l.numero === '5' && l.ano === 2017);
    expect(lei).toBeDefined();
    expect(lei!.afirmacaoVigencia).toBe('nenhuma');
    expect(
      o.leisCitadas.every((l) => l.afirmacaoVigencia !== 'revogada')
    ).toBe(true);
    expect(o.markdown).not.toMatch(LEXICO_VIGENCIA);
    expect(o.markdown).toMatch(/solicita-se (confirmação|esclarecimento)/i);
  });

  it('(b) lei revogada verificada match único → frase-template de revogação presente', async () => {
    const e = baseExtraction({
      leisReferenciadas: [leiRevogada],
      incoerencias: [
        {
          tipo: 'lei-revogada',
          descricao:
            'Edital cita a Lei 8.666/1993, revogada pela Lei 14.133/2021.',
          severidade: 'alta',
        },
      ],
    });
    const drafter = new GeminiDrafter(
      fakeModel({
        tipo: 'esclarecimento',
        selecoes: [{ fonte: 'incoerencia', indice: 0 }],
        leisCitadas: [
          { numero: '8666', ano: 1993, afirmacaoVigencia: 'revogada' },
        ],
      }) as never
    );

    const oficio = await drafter.redigir(e);
    expect(oficio).not.toBeNull();
    const lei = oficio!.leisCitadas.find((l) => l.numero === '8666');
    expect(lei!.afirmacaoVigencia).toBe('revogada');
    expect(oficio!.markdown).toMatch(/encontra-se revogada/i);
    // C1 3ª: a frase de proveniência é FIXA e determinística. O campo
    // `fonteVerificacao` (z.string() livre) NUNCA é interpolado verbatim —
    // nem mesmo o literal 'norma-baseline.json' do fixture.
    expect(oficio!.markdown).not.toContain('norma-baseline.json');
    expect(oficio!.markdown).toMatch(
      /conforme verificação de vigência registrada na análise/i
    );
  });

  it('(b-host) lei revogada-baseline com fonteVerificacao = URL oficial → cita só o HOST (escalar não-LLM), nunca prosa', async () => {
    // Caminho baseline-hit: 8666/1993 casa `matchNorma` (revogada-notoria) e
    // a fonteVerificacao é a URL curada real → cita só o domínio.
    const leiComUrl = {
      ...leiRevogada,
      fonteVerificacao:
        'https://www.planalto.gov.br/ccivil_03/leis/l8666cons.htm',
    };
    const e = baseExtraction({
      leisReferenciadas: [leiComUrl],
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
        selecoes: [{ fonte: 'incoerencia', indice: 0 }],
        leisCitadas: [
          { numero: '8666', ano: 1993, afirmacaoVigencia: 'revogada' },
        ],
      }) as never
    );
    const oficio = await drafter.redigir(e);
    expect(oficio).not.toBeNull();
    const md = oficio!.markdown;
    expect(md).toMatch(/encontra-se revogada/i);
    // Só o host, não a URL/path completa (escalar não-LLM derivado de curado).
    expect(md).toContain('www.planalto.gov.br');
    expect(md).not.toContain('/ccivil_03/');
    expect(md).not.toContain('l8666cons.htm');
  });

  it('(c) sem incoerências/ambíguos/manifestação → retorna null (gate B não dispara)', async () => {
    const e = baseExtraction();
    const drafter = new GeminiDrafter(
      fakeModel({
        tipo: 'esclarecimento',
        selecoes: [],
        leisCitadas: [],
      }) as never
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
        selecoes: [{ fonte: 'incoerencia', indice: 0 }],
        leisCitadas: [
          { numero: '8666', ano: 1993, afirmacaoVigencia: 'revogada' },
          { numero: '99999', ano: 2099, afirmacaoVigencia: 'revogada' },
        ],
      }) as never
    );

    const oficio = await drafter.redigir(e);
    expect(oficio).not.toBeNull();
    const numeros = oficio!.leisCitadas.map((l) => l.numero);
    expect(numeros).toContain('8666');
    expect(numeros).not.toContain('99999');
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
        selecoes: [{ fonte: 'pontoDeAtencao', indice: 0 }],
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
        selecoes: [{ fonte: 'pontoDeAtencao', indice: 0 }],
        leisCitadas: [
          { numero: '14133', ano: 2021, afirmacaoVigencia: 'vigente' },
        ],
      }) as never
    );
    const oficio = await drafter.redigir(e);
    const lei = oficio!.leisCitadas.find((l) => l.numero === '14133');
    expect(lei!.afirmacaoVigencia).toBe('nenhuma');
    expect(oficio!.markdown).not.toMatch(LEXICO_VIGENCIA);
  });
});

describe('GeminiDrafter — ADVERSARIAL: prosa livre estruturalmente impossível', () => {
  /**
   * O modelo TENTA injetar afirmação de revogação sobre lei `contestada`
   * (afirmacaoVigencia corretamente `nenhuma`) por TODO campo que ele
   * controla. Como NÃO existe mais campo de texto livre, e o corpo é 100%
   * templated, NENHUMA dessas strings pode aparecer — não é "filtrada",
   * é estruturalmente impossível. Cobre as 6 paráfrases que vazaram em
   * produção + mais (várias o regex anterior NÃO pegava).
   */
  const PARAFRASES_ATAQUE = [
    'a IN 05/2017 foi ab-rogada e não subsiste no ordenamento',
    'a norma foi superada, com eficácia exaurida',
    'a IN 05/2017 não está em vigor desde 2020',
    'a referida instrução revogou-se com a entrada da nova lei',
    'tal norma deixou de produzir efeitos e não vige mais',
    'a instrução está sem eficácia e foi derrogada',
  ];

  for (const ataque of PARAFRASES_ATAQUE) {
    it(`não vaza ataque via NENHUM campo do modelo: "${ataque.slice(0, 38)}…"`, async () => {
      const e = baseExtraction({
        leisReferenciadas: [leiContestada],
        // Achado estruturado existe; o modelo o seleciona legitimamente,
        // mas tenta contrabandear prosa de revogação por toda parte.
        trechosAmbiguos: [
          {
            trechoLiteral: 'critério de julgamento',
            porQueAmbiguo: 'redação dúbia',
            secaoOndeAparece: 'item 5',
          },
        ],
      });
      const drafter = new GeminiDrafter(
        fakeModel({
          // Campos extras que o modelo "controla" e pode tentar usar:
          tipo: 'esclarecimento',
          // tenta injetar via campos textuais legados, caso existam:
          pontos: [{ titulo: ataque, argumento: ataque }],
          titulo: ataque,
          argumento: ataque,
          textoLivre: ataque,
          observacao: ataque,
          selecoes: [
            { fonte: 'trechoAmbiguo', indice: 0, justificativa: ataque },
          ],
          leisCitadas: [
            { numero: '5', ano: 2017, afirmacaoVigencia: 'nenhuma' },
          ],
        }) as never
      );

      const oficio = await drafter.redigir(e);
      expect(oficio).not.toBeNull();
      const md = oficio!.markdown;
      // 1. A string de ataque literal NÃO aparece (não há canal por onde
      //    o modelo escreva texto livre no documento).
      expect(md).not.toContain(ataque);
      expect(md).not.toContain('05/2017');
      expect(md).not.toContain('IN 05');
      // 2. Nenhum léxico de (não)vigência (tripwire — não deveria nem ser
      //    necessário, pois não há prosa livre).
      expect(md).not.toMatch(LEXICO_VIGENCIA);
      // 3. A lei contestada permanece nenhuma.
      expect(
        oficio!.leisCitadas.every((l) => l.afirmacaoVigencia !== 'revogada')
      ).toBe(true);
    });
  }

  it('(C1-reincidente) modelo seleciona incoerência lei-revogada de lei contestada + tenta prosa → corpo templated não afirma revogação', async () => {
    // IN 05/2017 contestada; incoerência tipo lei-revogada cuja DESCRIÇÃO
    // (texto LLM a montante) diz "foi ab-rogada e não subsiste". O template
    // por TIPO da incoerência NUNCA interpola a descricao livre.
    const e = baseExtraction({
      leisReferenciadas: [leiContestada],
      incoerencias: [
        {
          tipo: 'lei-revogada',
          descricao:
            'A IN 05/2017 foi ab-rogada e não subsiste no ordenamento.',
          severidade: 'alta',
        },
      ],
    });
    const drafter = new GeminiDrafter(
      fakeModel({
        tipo: 'esclarecimento',
        selecoes: [{ fonte: 'incoerencia', indice: 0 }],
        leisCitadas: [
          { numero: '5', ano: 2017, afirmacaoVigencia: 'nenhuma' },
        ],
      }) as never
    );

    const oficio = await drafter.redigir(e);
    expect(oficio).not.toBeNull();
    const md = oficio!.markdown;
    expect(md).not.toContain('ab-rogada');
    expect(md).not.toContain('não subsiste');
    expect(md).not.toMatch(LEXICO_VIGENCIA);
    // O ponto de incoerência lei-revogada (sem lei verificada revogada)
    // vira pergunta neutra.
    expect(md).toMatch(/solicita-se (confirmação|esclarecimento)/i);
  });

  it('(C1-misto) 8666 revogada verificada + IN contestada na mesma extração → só a 8666 recebe frase-template de revogação', async () => {
    const e = baseExtraction({
      leisReferenciadas: [leiRevogada, leiContestada],
      incoerencias: [
        {
          tipo: 'lei-revogada',
          descricao:
            'Edital cita a Lei 8.666/93 (revogada) e a IN 05/2017 que ' +
            'igualmente perdeu vigência.',
          severidade: 'alta',
        },
      ],
    });
    const drafter = new GeminiDrafter(
      fakeModel({
        tipo: 'esclarecimento',
        selecoes: [{ fonte: 'incoerencia', indice: 0 }],
        leisCitadas: [
          { numero: '8666', ano: 1993, afirmacaoVigencia: 'revogada' },
          { numero: '5', ano: 2017, afirmacaoVigencia: 'nenhuma' },
        ],
      }) as never
    );

    const oficio = await drafter.redigir(e);
    expect(oficio).not.toBeNull();
    const md = oficio!.markdown;
    expect(
      oficio!.leisCitadas.find((l) => l.numero === '8666')!.afirmacaoVigencia
    ).toBe('revogada');
    expect(
      oficio!.leisCitadas.find((l) => l.numero === '5')!.afirmacaoVigencia
    ).toBe('nenhuma');
    expect(md).not.toContain('perdeu vigência');
    expect(md).toMatch(/8\.?666[\s\S]*encontra-se revogada/i);
    // Nenhuma frase de vigência ligada à 05/2017.
    expect(md).not.toMatch(/05\/?2017[^.]*?(revogad|perdeu vig|sem vig)/i);
    expect(md).not.toMatch(/(revogad|perdeu vig|sem vig)[^.]*?05\/?2017/i);
  });

  it('(C2) duas leis mesmo numero/ano (uma revogada, uma contestada) → lookup ambíguo NUNCA afirma revogação', async () => {
    const leiDup1 = {
      ...leiRevogada,
      descricao: 'Lei X (a)',
      numero: '777',
      ano: 2000,
      statusVerificado: 'revogada' as const,
    };
    const leiDup2 = {
      ...leiContestada,
      descricao: 'Lei X (b)',
      numero: '777',
      ano: 2000,
      statusVerificado: 'contestada' as const,
    };
    const e = baseExtraction({
      leisReferenciadas: [leiDup1, leiDup2],
      pontosDeAtencao: [pontoManifesta],
    });
    const drafter = new GeminiDrafter(
      fakeModel({
        tipo: 'esclarecimento',
        selecoes: [{ fonte: 'pontoDeAtencao', indice: 0 }],
        leisCitadas: [
          { numero: '777', ano: 2000, afirmacaoVigencia: 'revogada' },
        ],
      }) as never
    );

    const oficio = await drafter.redigir(e);
    expect(oficio).not.toBeNull();
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
        selecoes: [{ fonte: 'pontoDeAtencao', indice: 0 }],
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

  it('(seleção inválida) índice fora de range / fonte vazia → ignorado, sem crash, sem prosa', async () => {
    const e = baseExtraction({
      leisReferenciadas: [leiContestada],
      pontosDeAtencao: [pontoManifesta],
    });
    const drafter = new GeminiDrafter(
      fakeModel({
        tipo: 'esclarecimento',
        selecoes: [
          { fonte: 'incoerencia', indice: 99 },
          { fonte: 'pontoDeAtencao', indice: 0 },
        ],
        leisCitadas: [
          { numero: '5', ano: 2017, afirmacaoVigencia: 'nenhuma' },
        ],
      }) as never
    );
    const oficio = await drafter.redigir(e);
    expect(oficio).not.toBeNull();
    expect(oficio!.markdown).not.toMatch(LEXICO_VIGENCIA);
    expect(oficio!.markdown.trim().length).toBeGreaterThan(0);
  });

  it('(I1) incoerência tipo lei-revogada (descrição com "revogada") + lei contestada → corpo templated sem /revogad/i', async () => {
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
        selecoes: [
          { fonte: 'incoerencia', indice: 0 },
          { fonte: 'trechoAmbiguo', indice: 0 },
        ],
        leisCitadas: [
          { numero: '5', ano: 2017, afirmacaoVigencia: 'nenhuma' },
        ],
      }) as never
    );

    const oficio = await drafter.redigir(e);
    expect(oficio).not.toBeNull();
    expect(oficio!.markdown).not.toMatch(LEXICO_VIGENCIA);
    expect(oficio!.markdown).not.toMatch(/revogad/i);
    expect(oficio!.markdown).toMatch(/solicita-se esclarecimento/i);
  });

  it('(I2) incoerência só severidade:baixa, nada mais → redigir retorna null', async () => {
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
      fakeModel({
        tipo: 'esclarecimento',
        selecoes: [],
        leisCitadas: [],
      }) as never
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
        selecoes: [{ fonte: 'incoerencia', indice: 0 }],
        leisCitadas: [],
      }) as never
    );
    const oficio = await drafter.redigir(e);
    expect(oficio).not.toBeNull();
  });
});

/**
 * TDD ADVERSARIAL DE AUSÊNCIA ESTRUTURAL (C1 3ª review).
 *
 * Diagnóstico: o canal do MODELO está fechado (schema strip). Mas restam
 * canais de STRING LIVRE DE LLM A MONTANTE da extração (campos `z.string()`
 * livres do extractor / verifier) que eram interpolados verbatim no ofício
 * externo, guardados só pelo TRIPWIRE léxico — que a SPEC PROÍBE como
 * garantia. Estes testes injetam prosa de status SEM léxico que o tripwire
 * pega (o tripwire fica silencioso) e asseveram AUSÊNCIA ESTRUTURAL: a
 * string injetada NÃO aparece no `oficio.markdown` (toContain === false) e o
 * ofício continua válido. Provam a regressão (RED) e travam o fix (GREEN).
 *
 * Princípio (invariante exaustivo): todo caractere de `oficio.markdown` é
 * (a) literal de template, (b) enum restrito, (c) escalar não-LLM, ou (d)
 * frase-template determinística de vigência. NENHUMA string de texto livre
 * de LLM — do modelo do Drafter OU de campo `z.string()` livre da extração.
 *
 * Prosa de status SEM léxico que o regex de tripwire captura. Verificado:
 * `LEXICO_VIGENCIA.test(x) === false` para cada uma (asseverado abaixo).
 */
const PROSA_STATUS_SEM_LEXICO = [
  'tacitamente afastada pelo novo marco legal',
  'já não produz qualquer efeito jurídico no ordenamento',
  'não se aplica ao presente certame por força da disciplina superveniente',
  'foi tacitamente afastada e perdeu sua função normativa',
];

describe('GeminiDrafter — AUSÊNCIA ESTRUTURAL: zero string livre de LLM a montante', () => {
  it('as iscas de status NÃO casam o tripwire (senão o teste seria trivial)', () => {
    for (const p of PROSA_STATUS_SEM_LEXICO) {
      expect(LEXICO_VIGENCIA.test(p)).toBe(false);
    }
  });

  // --- Canal 1: trechoAmbiguo.secaoOndeAparece (z.string() livre do extractor) ---
  for (const isca of PROSA_STATUS_SEM_LEXICO) {
    it(`secaoOndeAparece não vaza prosa de status (sem léxico): "${isca.slice(0, 32)}…"`, async () => {
      const e = baseExtraction({
        leisReferenciadas: [leiContestada],
        trechosAmbiguos: [
          {
            trechoLiteral: 'critério de julgamento',
            porQueAmbiguo: 'redação dúbia',
            // Campo z.string() LIVRE do extractor — prosa de status injetada.
            secaoOndeAparece: `Item 5 — a IN 05/2017 ${isca}`,
          },
        ],
      });
      const drafter = new GeminiDrafter(
        fakeModel({
          tipo: 'esclarecimento',
          selecoes: [{ fonte: 'trechoAmbiguo', indice: 0 }],
          leisCitadas: [
            { numero: '5', ano: 2017, afirmacaoVigencia: 'nenhuma' },
          ],
        }) as never
      );

      const oficio = await drafter.redigir(e);
      expect(oficio).not.toBeNull();
      const md = oficio!.markdown;
      // AUSÊNCIA ESTRUTURAL: a prosa livre injetada não está no documento.
      expect(md).not.toContain(isca);
      expect(md).not.toContain('IN 05/2017');
      expect(md).not.toContain('05/2017');
      // Ofício continua válido (corpo templated, fecho presente).
      expect(md.trim().length).toBeGreaterThan(0);
      expect(md).toMatch(/solicita-se esclarecimento/i);
      expect(
        oficio!.leisCitadas.every((l) => l.afirmacaoVigencia !== 'revogada')
      ).toBe(true);
    });
  }

  it('secaoOndeAparece benigno também não é interpolado (referência por índice, não prosa)', async () => {
    const e = baseExtraction({
      leisReferenciadas: [leiContestada],
      trechosAmbiguos: [
        {
          trechoLiteral: 'critério de julgamento',
          porQueAmbiguo: 'redação dúbia',
          secaoOndeAparece: 'CLÁUSULA SÉTIMA — HABILITAÇÃO TÉCNICA XYZZY',
        },
      ],
    });
    const drafter = new GeminiDrafter(
      fakeModel({
        tipo: 'esclarecimento',
        selecoes: [{ fonte: 'trechoAmbiguo', indice: 0 }],
        leisCitadas: [],
      }) as never
    );
    const oficio = await drafter.redigir(e);
    expect(oficio).not.toBeNull();
    // Nenhum caractere de prosa livre do extractor entra — nem nome de seção.
    expect(oficio!.markdown).not.toContain('XYZZY');
    expect(oficio!.markdown).not.toContain('CLÁUSULA SÉTIMA');
    // Em vez disso, referência por ÍNDICE não-LLM ("ponto nº 1 da análise").
    expect(oficio!.markdown).toMatch(/ponto n[º°]\s*1\b/i);
  });

  // --- Canal 2: fonteVerificacao de GROUNDING (VerdictSchema.fonte z.string() do verifier) ---
  /**
   * Lei de CAUDA (não está em `data/norma-baseline.json`) com
   * `statusVerificado:'revogada'` vindo de GROUNDING — sua `fonteVerificacao`
   * é a string LIVRE `VerdictSchema.fonte` do LLM verifier. `matchNorma` não
   * a resolve (não-baseline) → `fonteBaseline=false` → NUNCA citável.
   */
  const leiCaudaGroundingRevogada = {
    descricao: 'Decreto Municipal nº 4.412/2017 (cauda obscura)',
    escopo: 'municipal' as const,
    tipoNorma: 'decreto' as const,
    numero: '4412',
    ano: 2017,
    contextoNoEdital: 'Regulamento de credenciamento citado no edital',
    revogada: true,
    statusVerificado: 'revogada' as const,
    fonteVerificacao: 'norma-baseline.json',
  };

  it('fonteVerificacao de GROUNDING (string livre do LLM verifier) não é interpolada no template de revogação', async () => {
    const grounding =
      'fonte: a norma foi tacitamente afastada conforme análise web não auditada';
    const e = baseExtraction({
      leisReferenciadas: [
        { ...leiCaudaGroundingRevogada, fonteVerificacao: grounding },
      ],
      incoerencias: [
        {
          tipo: 'lei-revogada',
          descricao: 'Decreto Municipal 4.412/2017 revogado.',
          severidade: 'alta',
        },
      ],
    });
    const drafter = new GeminiDrafter(
      fakeModel({
        tipo: 'esclarecimento',
        selecoes: [{ fonte: 'incoerencia', indice: 0 }],
        leisCitadas: [
          { numero: '4412', ano: 2017, afirmacaoVigencia: 'revogada' },
        ],
      }) as never
    );

    const oficio = await drafter.redigir(e);
    expect(oficio).not.toBeNull();
    const md = oficio!.markdown;
    // A frase-template de revogação É emitida (lei revogada verificada)…
    expect(md).toMatch(/encontra-se revogada/i);
    // …mas a string de grounding livre do LLM NÃO é interpolada.
    expect(md).not.toContain(grounding);
    expect(md).not.toContain('não auditada');
    expect(md).not.toContain('tacitamente afastada');
    // Proveniência fixa, sem embutir a string.
    expect(md).toMatch(
      /conforme verificação de vigência registrada na análise/i
    );
    expect(md.trim().length).toBeGreaterThan(0);
  });

  it('fonteVerificacao de grounding mesmo SEM léxico (prosa neutra) não entra no ofício', async () => {
    const grounding = 'verificação: a norma já não produz qualquer efeito jurídico';
    const e = baseExtraction({
      leisReferenciadas: [
        { ...leiCaudaGroundingRevogada, fonteVerificacao: grounding },
      ],
      incoerencias: [
        {
          tipo: 'lei-revogada',
          descricao: 'Decreto Municipal 4.412/2017 revogado.',
          severidade: 'alta',
        },
      ],
    });
    const drafter = new GeminiDrafter(
      fakeModel({
        tipo: 'esclarecimento',
        selecoes: [{ fonte: 'incoerencia', indice: 0 }],
        leisCitadas: [
          { numero: '4412', ano: 2017, afirmacaoVigencia: 'revogada' },
        ],
      }) as never
    );
    const oficio = await drafter.redigir(e);
    expect(oficio).not.toBeNull();
    expect(oficio!.markdown).not.toContain(grounding);
    expect(oficio!.markdown).not.toContain('já não produz qualquer efeito');
    expect(oficio!.markdown).toMatch(/encontra-se revogada/i);
  });

  it('fonteVerificacao de grounding que PARECE URL mas host não-oficial → não cita (não-baseline + allowlist)', async () => {
    // Mesmo URL bem-formada: se a lei é cauda (não-baseline) NUNCA cita;
    // e o host teria de passar a allowlist oficial de qualquer forma.
    const e = baseExtraction({
      leisReferenciadas: [
        {
          ...leiCaudaGroundingRevogada,
          fonteVerificacao: 'https://blog-juridico-aleatorio.com/post/123',
        },
      ],
      incoerencias: [
        {
          tipo: 'lei-revogada',
          descricao: 'Decreto Municipal 4.412/2017 revogado.',
          severidade: 'alta',
        },
      ],
    });
    const drafter = new GeminiDrafter(
      fakeModel({
        tipo: 'esclarecimento',
        selecoes: [{ fonte: 'incoerencia', indice: 0 }],
        leisCitadas: [
          { numero: '4412', ano: 2017, afirmacaoVigencia: 'revogada' },
        ],
      }) as never
    );
    const oficio = await drafter.redigir(e);
    expect(oficio).not.toBeNull();
    expect(oficio!.markdown).not.toContain('blog-juridico-aleatorio');
    expect(oficio!.markdown).toMatch(
      /conforme verificação de vigência registrada na análise/i
    );
  });
});
