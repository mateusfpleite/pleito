import { describe, it, expect } from 'vitest';
import { montarPrompt, TAREFA } from './prompt.ts';
import { SYSTEM_PROMPT } from './prompt.ts';
import { GeminiExtractor } from './gemini.ts';
import { ExtractorOutputSchema } from '../../domain/schema.ts';
import type { FonteMeta } from '../../domain/schema.ts';

/**
 * Testes DETERMINÍSTICOS do Extractor (LanguageModel mocado — NUNCA
 * chamamos o Gemini real nem testamos "o LLM retornou X";
 * @superpowers:testing-anti-patterns). Cobrem três invariantes:
 *
 *  (a) `montarPrompt` põe o texto do DOCUMENTO antes da string de TAREFA
 *      (recência long-context, SPEC §7) — assert por índice;
 *  (b) model fake devolvendo objeto válido → adapter retorna o parseado;
 *  (c) model fake devolvendo objeto que viola o schema → adapter rejeita.
 *
 * O mock implementa só a superfície de `generateObject` que o adapter usa:
 * `doGenerate` retornando JSON em `content`. Não dependemos de internals do
 * AI SDK além do contrato público de LanguageModelV2.
 */

const fonte: FonteMeta = {
  nomeArquivo: 'edital.txt',
  pdfNativo: false,
  ocr: false,
  paginas: 3,
  url: null,
};

/** Extração mínima válida contra ExtractorOutputSchema (sem pontosDeAtencao). */
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
 * LanguageModelV2 fake mínimo. Devolve `payload` (serializado) como texto;
 * `generateObject` (modo JSON) faz o parse + valida contra o schema.
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

describe('montarPrompt — ordem documento antes da tarefa (SPEC §7)', () => {
  it('(a) põe o texto do documento ANTES da string de tarefa', () => {
    const documento = 'CONTEUDO_UNICO_DO_EDITAL_12345';
    const prompt = montarPrompt(documento);

    const idxDoc = prompt.indexOf(documento);
    const idxTarefa = prompt.indexOf(TAREFA);

    expect(idxDoc).toBeGreaterThanOrEqual(0);
    expect(idxTarefa).toBeGreaterThanOrEqual(0);
    expect(idxDoc).toBeLessThan(idxTarefa);
  });

  it('few-shot fica no system prompt estático (cacheável), não no user', () => {
    const prompt = montarPrompt('qualquer texto');
    // Os exemplos few-shot vivem no SYSTEM (estático), não no prompt do user.
    expect(SYSTEM_PROMPT).toContain('EXEMPLO');
    expect(prompt).not.toContain('EXEMPLO');
  });
});

describe('GeminiExtractor — parse/validação (model injetado, sem rede)', () => {
  it('(b) model devolvendo objeto válido → retorna o parseado', async () => {
    const extractor = new GeminiExtractor(fakeModel(objetoValido) as never);
    const r = await extractor.extrair('texto do edital', fonte);

    expect(r.municipio).toBe('Jaborandi');
    expect(r.uf).toBe('BA');
    // statusVerificado preenchido pelo default do Zod (extractor não emite).
    expect(r.leisReferenciadas[0].statusVerificado).toBe('nao-verificado');
    // Carry-forward: o output do extractor NÃO tem pontosDeAtencao.
    expect('pontosDeAtencao' in r).toBe(false);
  });

  it('(c) model devolvendo objeto fora do schema → rejeita (throw)', async () => {
    const invalido = { ...objetoValido, uf: 'BAHIA' }; // uf deve ter length 2
    const extractor = new GeminiExtractor(fakeModel(invalido) as never);

    await expect(
      extractor.extrair('texto do edital', fonte)
    ).rejects.toThrow();
  });

  it('o objeto válido satisfaz ExtractorOutputSchema diretamente', () => {
    const parsed = ExtractorOutputSchema.parse(objetoValido);
    expect(parsed.municipio).toBe('Jaborandi');
  });
});
