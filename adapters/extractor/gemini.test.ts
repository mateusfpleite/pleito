import { describe, it, expect } from 'vitest';
import { montarPrompt, TAREFA } from './prompt.ts';
import { SYSTEM_PROMPT } from './prompt.ts';
import { GeminiExtractor } from './gemini.ts';
import { ExtractorOutputSchema } from '../../domain/schema.ts';
import type { FonteMeta } from '../../domain/schema.ts';

/**
 * DETERMINISTIC tests of the Extractor (LanguageModel mocked — we NEVER
 * call the real Gemini nor test "the LLM returned X";
 * @superpowers:testing-anti-patterns). They cover three invariants:
 *
 *  (a) `montarPrompt` places the DOCUMENT text before the TASK string
 *      (long-context recency, SPEC §7) — asserted by index;
 *  (b) fake model returning a valid object → adapter returns the parsed
 *      result;
 *  (c) fake model returning an object that violates the schema → adapter
 *      rejects.
 *
 * The mock implements only the `generateObject` surface the adapter uses:
 * `doGenerate` returning JSON in `content`. We do not depend on AI SDK
 * internals beyond the public LanguageModelV2 contract.
 */

const fonte: FonteMeta = {
  nomeArquivo: 'edital.txt',
  pdfNativo: false,
  ocr: false,
  paginas: 3,
  url: null,
};

/** Minimal extraction valid against ExtractorOutputSchema (no pontosDeAtencao). */
const objetoValido = {
  municipio: 'Jaborandi',
  uf: 'BA',
  ente: { tipo: 'prefeitura', razaoSocial: 'Prefeitura de Jaborandi', cnpj: null },
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
  leisReferenciadas: [
    {
      descricao: 'Lei nº 14.133/2021',
      escopo: 'federal',
      tipoNorma: 'lei',
      numero: '14133',
      ano: 2021,
      contextoNoEdital: 'Regime jurídico do edital',
      revogada: false,
      fonteVerificacao: null,
    },
  ],
  anexos: [],
  incoerencias: [],
  trechosAmbiguos: [],
  plataforma: null,
  subcontratacaoPermitida: null,
  intervaloMinimoLances: null,
  prazoRecursosDiasUteis: null,
  informacoesViabilidade: null,
  fonte: { pdfNativo: false, ocr: false, paginas: 3, url: null },
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
      throw new Error('doStream não usado pelo Extractor');
    },
  };
}

describe('montarPrompt — document before task order (SPEC §7)', () => {
  it('(a) places the document text BEFORE the task string', () => {
    const documento = 'CONTEUDO_UNICO_DO_EDITAL_12345';
    const prompt = montarPrompt(documento);

    const idxDoc = prompt.indexOf(documento);
    const idxTarefa = prompt.indexOf(TAREFA);

    expect(idxDoc).toBeGreaterThanOrEqual(0);
    expect(idxTarefa).toBeGreaterThanOrEqual(0);
    expect(idxDoc).toBeLessThan(idxTarefa);
  });

  it('few-shot stays in the static system prompt (cacheable), not in the user', () => {
    const prompt = montarPrompt('qualquer texto');
    // The few-shot examples live in the SYSTEM (static), not in the user prompt.
    expect(SYSTEM_PROMPT).toContain('EXEMPLO');
    expect(prompt).not.toContain('EXEMPLO');
  });
});

describe('GeminiExtractor — parse/validation (injected model, no network)', () => {
  it('(b) model returning a valid object → returns the parsed result', async () => {
    const extractor = new GeminiExtractor(fakeModel(objetoValido) as never);
    const r = await extractor.extrair('texto do edital', fonte);

    expect(r.municipio).toBe('Jaborandi');
    expect(r.uf).toBe('BA');
    // statusVerificado filled by the Zod default (the extractor does not emit it).
    expect(r.leisReferenciadas[0].statusVerificado).toBe('nao-verificado');
    // Carry-forward: the extractor output does NOT have pontosDeAtencao.
    expect('pontosDeAtencao' in r).toBe(false);
  });

  it('(c) model returning an off-schema object → rejects (throw)', async () => {
    const invalido = { ...objetoValido, uf: 'BAHIA' }; // uf must have length 2
    const extractor = new GeminiExtractor(fakeModel(invalido) as never);

    await expect(
      extractor.extrair('texto do edital', fonte)
    ).rejects.toThrow();
  });

  it('the valid object satisfies ExtractorOutputSchema directly', () => {
    const parsed = ExtractorOutputSchema.parse(objetoValido);
    expect(parsed.municipio).toBe('Jaborandi');
  });
});
