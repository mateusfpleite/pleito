import { describe, it, expect } from 'vitest';
import { GeminiNormaVerifier } from './gemini.ts';
import type { NormaCache, NormaCacheEntry } from '../../domain/ports.ts';
import { EditalExtractionSchema } from '../../domain/schema.ts';
import type { EditalExtraction } from '../../domain/schema.ts';

/**
 * Testes DETERMINÍSTICOS do Norma Verifier. Mock LanguageModel + fake
 * NormaCache in-memory — NUNCA chamamos Gemini real nem testamos "o LLM
 * retornou X" (@superpowers:testing-anti-patterns). As invariantes provadas:
 *
 *  (a) lei que casa baseline (8666/1993) → statusVerificado='revogada' e o
 *      model fake NÃO é chamado (spy=0 → precedência baseline sem grounding);
 *  (b) zona-cinzenta (IN 5/2017) → statusVerificado='contestada';
 *  (c) citacao-suspeita (9704/1995) → statusVerificado='inexistente';
 *  (d) lei fora da baseline → grounding chamado (spy>0), cache populado;
 *  (e) 2ª chamada da mesma lei fora-baseline → vem do cache (spy NÃO sobe).
 *
 * O mock implementa só a superfície de `generateText`+`Output.object` que o
 * adapter usa: `doGenerate` devolve JSON do verdict em `content`. Conta
 * chamadas (`calls`) para provar precedência/cache com contadores reais.
 */

/** Extração base válida; cada teste injeta `leisReferenciadas`. */
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

/** Fake NormaCache in-memory (o adapter Supabase real vem na Phase 11). */
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
 * LanguageModelV2 fake. `verdict` é o objeto que o grounding "retornaria";
 * `calls` conta cada `doGenerate` (spy real p/ provar precedência/cache).
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

describe('GeminiNormaVerifier — precedência baseline (custo zero, sem grounding)', () => {
  it('(a) lei que casa baseline (8666/1993) → revogada, model NÃO chamado', async () => {
    const { model, state } = spyModel({ status: 'vigente', fonte: 'x' });
    const cache = fakeCache();
    const verifier = new GeminiNormaVerifier(cache, model as never);

    const e = baseExtraction([
      lei({ numero: '8666', ano: 1993, escopo: 'federal', tipoNorma: 'lei' }),
    ]);
    const r = await verifier.verificar(e);

    expect(r.leisReferenciadas[0].statusVerificado).toBe('revogada');
    expect(r.leisReferenciadas[0].fonteVerificacao).toContain('planalto');
    // Precedência provada: hit baseline NÃO aciona grounding.
    expect(state.calls).toBe(0);
  });

  it('(b) zona-cinzenta (IN 5/2017) → contestada, sem grounding', async () => {
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

  it('(c) citacao-suspeita (9704/1995) → inexistente, sem grounding', async () => {
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

describe('GeminiNormaVerifier — grounding na cauda (miss baseline) + cache', () => {
  it('(d) lei fora da baseline → grounding chamado, cache consultado e populado', async () => {
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

    expect(state.calls).toBe(1); // grounding acionado (miss baseline)
    expect(r.leisReferenciadas[0].statusVerificado).toBe('revogada');
    expect(r.leisReferenciadas[0].fonteVerificacao).toBe(
      'https://planalto.gov.br/exemplo'
    );
    // Cache populado com chave estável numero|ano|escopo.
    const cached = await cache.obter('9999|1999|municipal');
    expect(cached).not.toBeNull();
    expect(cached?.status).toBe('revogada');
  });

  it('(e) 2ª chamada da mesma lei fora-baseline → vem do cache (sem novo grounding)', async () => {
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
    // Cache hit: grounding NÃO chamado de novo (contador estável).
    expect(state.calls).toBe(1);
    expect(r2.leisReferenciadas[0].statusVerificado).toBe('revogada');
    expect(r2.leisReferenciadas[0].fonteVerificacao).toBe(
      'https://planalto.gov.br/exemplo'
    );
  });

  it('não muta os demais campos da extração', async () => {
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
 * SPEC §11b — custo de grounding logado POR CHAMADA (não só agregado).
 * Prova-se com o sink injetado + spy real de chamadas: cada chamada de
 * grounding gera EXATAMENTE 1 evento de custo; hit de baseline/cache gera
 * ZERO. (testing-anti-patterns: model fake + telemetry fake — provamos a
 * instrumentação determinística, não o LLM.)
 */
describe('GeminiNormaVerifier — custo de grounding POR chamada (§11b)', () => {
  it('cada chamada de grounding → exatamente 1 evento de custo', async () => {
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

    // 2 leis fora-baseline distintas → 2 chamadas de grounding.
    const e = baseExtraction([
      lei({ numero: '7777', ano: 2001, escopo: 'municipal', tipoNorma: 'lei' }),
      lei({ numero: '8888', ano: 2002, escopo: 'estadual', tipoNorma: 'lei' }),
    ]);
    await verifier.verificar(e);

    expect(state.calls).toBe(2); // 2 groundings reais
    // 1 evento de custo POR chamada — não agregado num só.
    expect(eventos).toHaveLength(2);
    expect(eventos.map((x) => x.lei).sort()).toEqual([
      '7777/2001',
      '8888/2002',
    ]);
    // O uso da chamada é repassado (do `usage` do generateText fake).
    expect(eventos[0].inputTokens).toBe(1);
    expect(eventos[0].totalTokens).toBe(2);
  });

  it('hit de baseline NÃO emite evento de custo (não houve grounding)', async () => {
    const { model, state } = spyModel({ status: 'vigente', fonte: 'x' });
    const eventos: unknown[] = [];
    const verifier = new GeminiNormaVerifier(
      fakeCache(),
      model as never,
      () => eventos.push(1)
    );
    // 8666/1993 casa baseline → precedência, sem grounding.
    await verifier.verificar(
      baseExtraction([
        lei({ numero: '8666', ano: 1993, escopo: 'federal', tipoNorma: 'lei' }),
      ])
    );
    expect(state.calls).toBe(0);
    expect(eventos).toHaveLength(0);
  });

  it('cache hit NÃO emite novo evento de custo (só a 1ª chamada)', async () => {
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
    await verifier.verificar(mk()); // grounding real → 1 evento
    await verifier.verificar(mk()); // cache hit → NENHUM evento novo
    expect(eventos).toHaveLength(1);
  });
});
