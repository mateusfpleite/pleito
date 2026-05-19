import { describe, it, expect } from 'vitest';
import { GeminiDrafter } from './gemini.ts';
import { montarPrompt, TAREFA, SYSTEM_PROMPT } from './prompt.ts';
import { EditalExtractionSchema } from '../../domain/schema.ts';
import type { EditalExtraction } from '../../domain/schema.ts';

/**
 * DETERMINISTIC ADVERSARIAL tests of the Drafter (REAL STRUCTURAL
 * containment, SPEC §5 #2). The LanguageModel is mocked — we NEVER call the
 * real Gemini nor test "the LLM returned X"
 * (@superpowers:testing-anti-patterns). The proven invariants are
 * properties of the ADAPTER.
 *
 * NEW CONTRACT (ZERO free model prose in the external ofício):
 *   The model emits ONLY structured decisions:
 *     - `tipo` ∈ {esclarecimento, impugnacao};
 *     - `selecoes[]`: each one references a finding ALREADY PRESENT in the
 *       extraction via `{fonte∈{incoerencia,trechoAmbiguo,pontoDeAtencao},
 *       indice}` — i.e. the model chooses WHAT to raise and the ORDER, it
 *       does not WRITE;
 *     - `leisCitadas[]` with `afirmacaoVigencia` (already structural).
 *   There is NO MORE free-text field (`pontos[].argumento`/`titulo`). The
 *   ofício body is assembled 100% by deterministic TEMPLATES keyed by the
 *   finding's structured TIPO. That is why "ab-rogada"/"não subsiste"/etc.
 *   are STRUCTURALLY IMPOSSIBLE to appear — there is no channel through
 *   which the model writes that text, it is not "filtered".
 *
 * The lexical backstop (LEXICO_VIGENCIA) is a defensive TRIPWIRE: if it
 * fires, it is a structural bug. The guarantee is the ABSENCE of free
 * prose, not the regex.
 *
 * The mock implements only the `generateObject` surface the adapter uses:
 * `doGenerate` returns the JSON proposed by the model in `content`.
 */

/** Valid base extraction; each test injects leis/incoerências/pontos. */
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

/** Revoked and verified lei. */
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

/** Lei in zona-cinzenta (contested): MUST NOT become an assertion in the ofício. */
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

/** A ponto that recommends manifestation → gate B fires. */
const pontoManifesta = {
  descricao: 'Vedação à participação em consórcio sem justificativa técnica.',
  categoria: 'competitivo' as const,
  severidade: 'alta' as const,
  recomendaManifestacao: true,
};

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
      throw new Error('doStream não usado pelo Drafter');
    },
  };
}

describe('montarPrompt — extraction before task order (SPEC §7)', () => {
  it('places the extraction BEFORE the task string (recency)', () => {
    const prompt = montarPrompt(baseExtraction({ incoerencias: [] }));
    const idxDoc = prompt.indexOf('"municipio"');
    const idxTarefa = prompt.indexOf(TAREFA);
    expect(idxDoc).toBeGreaterThanOrEqual(0);
    expect(idxTarefa).toBeGreaterThanOrEqual(0);
    expect(idxDoc).toBeLessThan(idxTarefa);
  });

  it('few-shot Pariconha stays in the static SYSTEM, not in the user prompt', () => {
    const prompt = montarPrompt(baseExtraction());
    expect(SYSTEM_PROMPT).toMatch(/pariconha/i);
    expect(SYSTEM_PROMPT).toContain('OFÍCIO DE ESCLARECIMENTO');
    expect(prompt).not.toContain('OFÍCIO DE ESCLARECIMENTO');
  });

  it('the SYSTEM teaches that the model does NOT write (only selects findings)', () => {
    expect(SYSTEM_PROMPT).toMatch(/afirmacaoVigencia/);
    expect(SYSTEM_PROMPT).toMatch(/selecoes/);
    // The contract explicitly forbids free text.
    expect(SYSTEM_PROMPT).toMatch(/N[ÃA]O escreve|n[ãa]o redige|sem prosa/i);
  });
});

/**
 * Lexical tripwire (NOT the guarantee; if it fires it is a structural bug).
 * Includes the paraphrases that leaked in production and more.
 */
const LEXICO_VIGENCIA =
  /revogad|ab-?rogad|derrogad|revogou-se|perdeu vig[êe]ncia|n[ãa]o subsiste|superad|exaurid|deixou de produzir efeitos|n[ãa]o vige|sem efic[áa]cia|n[ãa]o est[áa] (mais )?em vigor|deixou de viger|sem vig[êe]ncia|caducou/i;

describe('GeminiDrafter — REAL structural containment (injected model, no network)', () => {
  it('(a) contested law + fake tries revoked → adapter FORCES none; markdown does not assert revocation', async () => {
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

  it('(b) verified revoked law with single match → revocation template phrase present', async () => {
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
    // C1 3rd: the provenance phrase is FIXED and deterministic. The
    // `fonteVerificacao` field (free z.string()) is NEVER interpolated
    // verbatim — not even the fixture's literal 'norma-baseline.json'.
    expect(oficio!.markdown).not.toContain('norma-baseline.json');
    expect(oficio!.markdown).toMatch(
      /conforme verificação de vigência registrada na análise/i
    );
  });

  it('(b-host) baseline-revoked law with fonteVerificacao = official URL → cites only the HOST (non-LLM scalar), never prose', async () => {
    // Baseline-hit path: 8666/1993 matches `matchNorma` (revogada-notoria)
    // and fonteVerificacao is the real curated URL → cites only the domain.
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
    // Only the host, not the full URL/path (non-LLM scalar derived from curated).
    expect(md).toContain('www.planalto.gov.br');
    expect(md).not.toContain('/ccivil_03/');
    expect(md).not.toContain('l8666cons.htm');
  });

  it('(c) no inconsistencies/ambiguities/manifestation → returns null (gate B does not fire)', async () => {
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

  it('(d) leisCitadas is a subset of leisReferenciadas (discards invented law)', async () => {
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

  it('(e) tipo ∈ enum and markdown non-empty when non-null', async () => {
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

  it('(b2) model tries to force "vigente" on an in-force law → adapter normalizes to "nenhuma"', async () => {
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

describe('GeminiDrafter — ADVERSARIAL: free prose structurally impossible', () => {
  /**
   * The model TRIES to inject a revocation assertion about a `contested`
   * lei (afirmacaoVigencia correctly `nenhuma`) through EVERY field it
   * controls. Since there is NO free-text field anymore, and the body is
   * 100% templated, NONE of these strings can appear — it is not
   * "filtered", it is structurally impossible. Covers the 6 paraphrases
   * that leaked in production + more (several the previous regex did NOT
   * catch).
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
    it(`does not leak attack via ANY model field: "${ataque.slice(0, 38)}…"`, async () => {
      const e = baseExtraction({
        leisReferenciadas: [leiContestada],
        // The structured finding exists; the model selects it legitimately,
        // but tries to smuggle revocation prose everywhere.
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
          // Extra fields the model "controls" and might try to use:
          tipo: 'esclarecimento',
          // tries to inject via legacy text fields, if they exist:
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
      // 1. The literal attack string does NOT appear (there is no channel
      //    through which the model writes free text into the document).
      expect(md).not.toContain(ataque);
      expect(md).not.toContain('05/2017');
      expect(md).not.toContain('IN 05');
      // 2. No (non-)validity lexicon (tripwire — should not even be
      //    necessary, since there is no free prose).
      expect(md).not.toMatch(LEXICO_VIGENCIA);
      // 3. The contested lei stays nenhuma.
      expect(
        oficio!.leisCitadas.every((l) => l.afirmacaoVigencia !== 'revogada')
      ).toBe(true);
    });
  }

  it('(C1-recurring) model selects lei-revogada inconsistency from a contested law + tries prose → templated body does not assert revocation', async () => {
    // IN 05/2017 contested; lei-revogada-type incoerência whose DESCRIPTION
    // (upstream LLM text) says "foi ab-rogada e não subsiste". The template
    // keyed by the incoerência TIPO NEVER interpolates the free descricao.
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
    // The lei-revogada incoerência point (without a verified revoked lei)
    // becomes a neutral question.
    expect(md).toMatch(/solicita-se (confirmação|esclarecimento)/i);
  });

  it('(C1-mixed) 8666 verified revoked + contested IN in the same extraction → only 8666 receives the revocation template phrase', async () => {
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
    // No validity phrase tied to 05/2017.
    expect(md).not.toMatch(/05\/?2017[^.]*?(revogad|perdeu vig|sem vig)/i);
    expect(md).not.toMatch(/(revogad|perdeu vig|sem vig)[^.]*?05\/?2017/i);
  });

  it('(C2) two laws with same numero/ano (one revoked, one contested) → ambiguous lookup NEVER asserts revocation', async () => {
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

  it('(C2) numero:null is never a reliable match → never asserts revocation', async () => {
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

  it('(invalid selection) out-of-range index / empty source → ignored, no crash, no prose', async () => {
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

  it('(I1) lei-revogada type inconsistency (description with "revogada") + contested law → templated body without /revogad/i', async () => {
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

  it('(I2) inconsistency only severidade:baixa, nothing else → redigir returns null', async () => {
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

  it('(I2) inconsistency severidade:media → gate B fires (non-null)', async () => {
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
 * ADVERSARIAL TDD FOR STRUCTURAL ABSENCE (C1 3rd review).
 *
 * Diagnosis: the MODEL channel is closed (schema strip). But there remain
 * FREE LLM STRING channels UPSTREAM of the extraction (free `z.string()`
 * fields from the extractor / verifier) that were interpolated verbatim
 * into the external ofício, guarded only by the lexical TRIPWIRE — which
 * the SPEC FORBIDS as a guarantee. These tests inject status prose WITHOUT
 * lexicon that the tripwire catches (the tripwire stays silent) and assert
 * STRUCTURAL ABSENCE: the injected string does NOT appear in
 * `oficio.markdown` (toContain === false) and the ofício stays valid. They
 * prove the regression (RED) and lock the fix (GREEN).
 *
 * Principle (exhaustive invariant): every character of `oficio.markdown` is
 * (a) a template literal, (b) a restricted enum, (c) a non-LLM scalar, or
 * (d) a deterministic validity template phrase. NO free LLM text string —
 * from the Drafter model OR from a free `z.string()` extraction field.
 *
 * Status prose WITHOUT lexicon that the tripwire regex captures. Verified:
 * `LEXICO_VIGENCIA.test(x) === false` for each one (asserted below).
 */
const PROSA_STATUS_SEM_LEXICO = [
  'tacitamente afastada pelo novo marco legal',
  'já não produz qualquer efeito jurídico no ordenamento',
  'não se aplica ao presente certame por força da disciplina superveniente',
  'foi tacitamente afastada e perdeu sua função normativa',
];

describe('GeminiDrafter — STRUCTURAL ABSENCE: zero upstream free LLM string', () => {
  it('the status decoys do NOT match the tripwire (otherwise the test would be trivial)', () => {
    for (const p of PROSA_STATUS_SEM_LEXICO) {
      expect(LEXICO_VIGENCIA.test(p)).toBe(false);
    }
  });

  // --- Channel 1: trechoAmbiguo.secaoOndeAparece (free extractor z.string()) ---
  for (const isca of PROSA_STATUS_SEM_LEXICO) {
    it(`secaoOndeAparece does not leak status prose (no lexicon): "${isca.slice(0, 32)}…"`, async () => {
      const e = baseExtraction({
        leisReferenciadas: [leiContestada],
        trechosAmbiguos: [
          {
            trechoLiteral: 'critério de julgamento',
            porQueAmbiguo: 'redação dúbia',
            // FREE extractor z.string() field — injected status prose.
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
      // STRUCTURAL ABSENCE: the injected free prose is not in the document.
      expect(md).not.toContain(isca);
      expect(md).not.toContain('IN 05/2017');
      expect(md).not.toContain('05/2017');
      // Ofício stays valid (templated body, closing present).
      expect(md.trim().length).toBeGreaterThan(0);
      expect(md).toMatch(/solicita-se esclarecimento/i);
      expect(
        oficio!.leisCitadas.every((l) => l.afirmacaoVigencia !== 'revogada')
      ).toBe(true);
    });
  }

  it('benign secaoOndeAparece is also not interpolated (reference by index, not prose)', async () => {
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
    // No free extractor prose character enters — not even a section name.
    expect(oficio!.markdown).not.toContain('XYZZY');
    expect(oficio!.markdown).not.toContain('CLÁUSULA SÉTIMA');
    // Instead, a non-LLM INDEX reference ("ponto nº 1 da análise").
    expect(oficio!.markdown).toMatch(/ponto n[º°]\s*1\b/i);
  });

  // --- Channel 2: GROUNDING fonteVerificacao (verifier VerdictSchema.fonte z.string()) ---
  /**
   * TAIL lei (not in `data/norma-baseline.json`) with
   * `statusVerificado:'revogada'` coming from GROUNDING — its
   * `fonteVerificacao` is the LLM verifier's FREE `VerdictSchema.fonte`
   * string. `matchNorma` does not resolve it (non-baseline) →
   * `fonteBaseline=false` → NEVER citable.
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

  it('fonteVerificacao from GROUNDING (free LLM verifier string) is not interpolated into the revocation template', async () => {
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
    // The revocation template phrase IS emitted (verified revoked lei)…
    expect(md).toMatch(/encontra-se revogada/i);
    // …but the LLM's free grounding string is NOT interpolated.
    expect(md).not.toContain(grounding);
    expect(md).not.toContain('não auditada');
    expect(md).not.toContain('tacitamente afastada');
    // Fixed provenance, without embedding the string.
    expect(md).toMatch(
      /conforme verificação de vigência registrada na análise/i
    );
    expect(md.trim().length).toBeGreaterThan(0);
  });

  it('grounding fonteVerificacao even WITHOUT lexicon (neutral prose) does not enter the ofício', async () => {
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

  it('grounding fonteVerificacao that LOOKS like a URL but with non-official host → does not cite (non-baseline + allowlist)', async () => {
    // Even a well-formed URL: if the lei is tail (non-baseline) it NEVER
    // cites; and the host would have to pass the official allowlist anyway.
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
