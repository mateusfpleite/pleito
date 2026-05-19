import { describe, it, expect } from 'vitest';
import { GeminiNormaVerifier } from './gemini.ts';
import type { NormaCache, NormaCacheEntry } from '../../domain/ports.ts';
import { EditalExtractionSchema } from '../../domain/schema.ts';
import type { EditalExtraction } from '../../domain/schema.ts';

/**
 * DETERMINISTIC tests of the Norma Verifier. Mock LanguageModel + fake
 * in-memory NormaCache — we NEVER call the real Gemini nor test "the LLM
 * returned X" (@superpowers:testing-anti-patterns). The proven invariants:
 *
 *  (a) lei that matches baseline (8666/1993) → statusVerificado='revogada'
 *      and the fake model is NOT called (spy=0 → baseline precedence
 *      without grounding);
 *  (b) zona-cinzenta (IN 5/2017) → statusVerificado='contestada';
 *  (c) citacao-suspeita (9704/1995) → statusVerificado='inexistente';
 *  (d) lei outside the baseline → grounding called (spy>0), cache
 *      populated;
 *  (e) 2nd call of the same outside-baseline lei → comes from the cache
 *      (spy does NOT rise).
 *
 * The mock implements only the `generateText`+`Output.object` surface the
 * adapter uses: `doGenerate` returns the verdict JSON in `content`. It
 * counts calls (`calls`) to prove precedence/cache with real counters.
 */

/** Valid base extraction; each test injects `leisReferenciadas`. */
function baseExtraction(
  leis: EditalExtraction['leisReferenciadas']
): EditalExtraction {
  return EditalExtractionSchema.parse({
    municipio: 'Jaborandi',
    uf: 'BA',
    ente: {
      tipo: 'prefeitura',
      razaoSocial: 'Prefeitura de Jaborandi',
      cnpj: null,
    },
    modalidade: 'pregao-eletronico',
    numero: '5/2024',
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
    leisReferenciadas: leis,
    anexos: [],
    incoerencias: [],
    trechosAmbiguos: [],
    plataforma: null,
    subcontratacaoPermitida: null,
    intervaloMinimoLances: null,
    prazoRecursosDiasUteis: null,
    informacoesViabilidade: null,
    pontosDeAtencao: [],
    fonte: { pdfNativo: false, ocr: false, paginas: 3, url: null },
  });
}

function lei(
  over: Partial<EditalExtraction['leisReferenciadas'][number]>
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

/** Fake in-memory NormaCache (the real Supabase adapter arrives in Phase 11). */
function fakeCache(): NormaCache & { store: Map<string, NormaCacheEntry> } {
  const store = new Map<string, NormaCacheEntry>();
  return {
    store,
    async obter(chave) {
      return store.get(chave) ?? null;
    },
    async gravar(entry) {
      store.set(entry.chave, { ...entry, verificadoEm: new Date() });
    },
  };
}

/**
 * Fake LanguageModelV2. `verdict` is the object grounding "would return";
 * `calls` counts each `doGenerate` (real spy to prove precedence/cache).
 */
function spyModel(verdict: { status: string; fonte: string }) {
  const state = { calls: 0 };
  const model = {
    specificationVersion: 'v2' as const,
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    async doGenerate() {
      state.calls += 1;
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(verdict) },
        ],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error('doStream não usado pelo Verifier');
    },
  };
  return { model, state };
}

describe('GeminiNormaVerifier — baseline precedence (zero cost, no grounding)', () => {
  it('(a) law that matches baseline (8666/1993) → revogada, model NOT called', async () => {
    const { model, state } = spyModel({ status: 'vigente', fonte: 'x' });
    const cache = fakeCache();
    const verifier = new GeminiNormaVerifier(cache, model as never);

    const e = baseExtraction([
      lei({ numero: '8666', ano: 1993, escopo: 'federal', tipoNorma: 'lei' }),
    ]);
    const r = await verifier.verificar(e);

    expect(r.leisReferenciadas[0].statusVerificado).toBe('revogada');
    expect(r.leisReferenciadas[0].fonteVerificacao).toContain('planalto');
    // Precedence proven: a baseline hit does NOT trigger grounding.
    expect(state.calls).toBe(0);
  });

  it('(b) zona-cinzenta (IN 5/2017) → contestada, no grounding', async () => {
    const { model, state } = spyModel({ status: 'vigente', fonte: 'x' });
    const verifier = new GeminiNormaVerifier(fakeCache(), model as never);

    const e = baseExtraction([
      lei({
        numero: '5',
        ano: 2017,
        escopo: 'federal',
        tipoNorma: 'instrucao-normativa',
      }),
    ]);
    const r = await verifier.verificar(e);

    expect(r.leisReferenciadas[0].statusVerificado).toBe('contestada');
    expect(state.calls).toBe(0);
  });

  it('(c) citacao-suspeita (9704/1995) → inexistente, no grounding', async () => {
    const { model, state } = spyModel({ status: 'vigente', fonte: 'x' });
    const verifier = new GeminiNormaVerifier(fakeCache(), model as never);

    const e = baseExtraction([
      lei({ numero: '9704', ano: 1995, escopo: 'federal', tipoNorma: 'lei' }),
    ]);
    const r = await verifier.verificar(e);

    expect(r.leisReferenciadas[0].statusVerificado).toBe('inexistente');
    expect(state.calls).toBe(0);
  });
});

describe('GeminiNormaVerifier — grounding on the tail (baseline miss) + cache', () => {
  it('(d) law outside baseline → grounding called, cache consulted and populated', async () => {
    const { model, state } = spyModel({
      status: 'revogada',
      fonte: 'https://planalto.gov.br/exemplo',
    });
    const cache = fakeCache();
    const verifier = new GeminiNormaVerifier(cache, model as never);

    const e = baseExtraction([
      lei({ numero: '9999', ano: 1999, escopo: 'municipal', tipoNorma: 'lei' }),
    ]);
    const r = await verifier.verificar(e);

    expect(state.calls).toBe(1); // grounding triggered (baseline miss)
    expect(r.leisReferenciadas[0].statusVerificado).toBe('revogada');
    expect(r.leisReferenciadas[0].fonteVerificacao).toBe(
      'https://planalto.gov.br/exemplo'
    );
    // Cache populated with the stable key numero|ano|escopo.
    const cached = await cache.obter('9999|1999|municipal');
    expect(cached).not.toBeNull();
    expect(cached?.status).toBe('revogada');
  });

  it('(e) 2nd call of the same outside-baseline law → comes from cache (no new grounding)', async () => {
    const { model, state } = spyModel({
      status: 'revogada',
      fonte: 'https://planalto.gov.br/exemplo',
    });
    const cache = fakeCache();
    const verifier = new GeminiNormaVerifier(cache, model as never);

    const mk = () =>
      baseExtraction([
        lei({ numero: '9999', ano: 1999, escopo: 'municipal', tipoNorma: 'lei' }),
      ]);

    await verifier.verificar(mk());
    expect(state.calls).toBe(1);

    const r2 = await verifier.verificar(mk());
    // Cache hit: grounding NOT called again (stable counter).
    expect(state.calls).toBe(1);
    expect(r2.leisReferenciadas[0].statusVerificado).toBe('revogada');
    expect(r2.leisReferenciadas[0].fonteVerificacao).toBe(
      'https://planalto.gov.br/exemplo'
    );
  });

  it('does not mutate the other extraction fields', async () => {
    const { model } = spyModel({ status: 'vigente', fonte: 'web' });
    const verifier = new GeminiNormaVerifier(fakeCache(), model as never);

    const e = baseExtraction([
      lei({ numero: '8666', ano: 1993, escopo: 'federal', tipoNorma: 'lei' }),
    ]);
    const r = await verifier.verificar(e);

    expect(r.municipio).toBe('Jaborandi');
    expect(r.uf).toBe('BA');
    expect(r.regimeJuridico).toBe('lei-14133');
    expect(r.leisReferenciadas).toHaveLength(1);
  });
});

/**
 * SPEC §11b — grounding cost logged PER CALL (not just aggregated).
 * Proven with the injected sink + real call spy: each grounding call
 * generates EXACTLY 1 cost event; a baseline/cache hit generates ZERO.
 * (testing-anti-patterns: fake model + fake telemetry — we prove the
 * deterministic instrumentation, not the LLM.)
 */
describe('GeminiNormaVerifier — grounding cost PER call (§11b)', () => {
  it('each grounding call → exactly 1 cost event', async () => {
    const { model, state } = spyModel({
      status: 'revogada',
      fonte: 'https://planalto.gov.br/x',
    });
    const eventos: Array<{
      lei: string;
      inputTokens: number | undefined;
      totalTokens: number | undefined;
    }> = [];
    const verifier = new GeminiNormaVerifier(
      fakeCache(),
      model as never,
      (u) =>
        eventos.push({
          lei: u.lei,
          inputTokens: u.inputTokens,
          totalTokens: u.totalTokens,
        })
    );

    // 2 distinct outside-baseline leis → 2 grounding calls.
    const e = baseExtraction([
      lei({ numero: '7777', ano: 2001, escopo: 'municipal', tipoNorma: 'lei' }),
      lei({ numero: '8888', ano: 2002, escopo: 'estadual', tipoNorma: 'lei' }),
    ]);
    await verifier.verificar(e);

    expect(state.calls).toBe(2); // 2 real groundings
    // 1 cost event PER call — not aggregated into one.
    expect(eventos).toHaveLength(2);
    expect(eventos.map((x) => x.lei).sort()).toEqual([
      '7777/2001',
      '8888/2002',
    ]);
    // The call's usage is forwarded (from the fake generateText `usage`).
    expect(eventos[0].inputTokens).toBe(1);
    expect(eventos[0].totalTokens).toBe(2);
  });

  it('baseline hit does NOT emit a cost event (there was no grounding)', async () => {
    const { model, state } = spyModel({ status: 'vigente', fonte: 'x' });
    const eventos: unknown[] = [];
    const verifier = new GeminiNormaVerifier(
      fakeCache(),
      model as never,
      () => eventos.push(1)
    );
    // 8666/1993 matches baseline → precedence, no grounding.
    await verifier.verificar(
      baseExtraction([
        lei({ numero: '8666', ano: 1993, escopo: 'federal', tipoNorma: 'lei' }),
      ])
    );
    expect(state.calls).toBe(0);
    expect(eventos).toHaveLength(0);
  });

  it('cache hit does NOT emit a new cost event (only the 1st call)', async () => {
    const { model } = spyModel({
      status: 'revogada',
      fonte: 'https://planalto.gov.br/y',
    });
    const eventos: unknown[] = [];
    const cache = fakeCache();
    const verifier = new GeminiNormaVerifier(
      cache,
      model as never,
      () => eventos.push(1)
    );
    const mk = () =>
      baseExtraction([
        lei({ numero: '6543', ano: 2010, escopo: 'municipal', tipoNorma: 'lei' }),
      ]);
    await verifier.verificar(mk()); // real grounding → 1 event
    await verifier.verificar(mk()); // cache hit → NO new event
    expect(eventos).toHaveLength(1);
  });
});
