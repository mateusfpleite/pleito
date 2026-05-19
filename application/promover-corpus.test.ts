import { describe, it, expect } from 'vitest';
import {
  promoverParaCorpus,
  slugFixture,
  GOLD_DIR,
} from './promover-corpus.ts';
import { EditalExtractionSchema } from '../domain/schema.ts';
import type {
  AnaliseRegistro,
  AnalysisRepo,
  OficioGerado,
} from '../domain/ports.ts';

/**
 * Testes DETERMINÍSTICOS do promote-to-corpus (§11b). Sem fs real: o
 * escritor é injetado (captura caminho+conteúdo). Provas:
 *  - escreve em `fixtures/gold/` (versionado, NÃO `output/`);
 *  - nome do arquivo derivado de município/uf (slug seguro);
 *  - o JSON escrito PARSEIA contra EditalExtractionSchema (é fixture
 *    válida de Tier 0 — o runner safeParse-aria com sucesso);
 *  - `_proveniencia` presente (auditoria) e NÃO quebra o parse;
 *  - análise inexistente → lança.
 */

const extracao = EditalExtractionSchema.parse({
  municipio: 'São José dos Campos',
  uf: 'SP',
  ente: { tipo: 'prefeitura', razaoSocial: 'PMSJC', cnpj: null },
  modalidade: 'pregao-eletronico',
  numero: '42/2026',
  processoAdministrativo: null,
  dataPublicacao: null,
  dataSessao: null,
  uasg: null,
  regimeJuridico: 'lei-14133',
  objetoCorpo: 'Serviços funerários',
  objetoCapa: null,
  objetoSummary: 'Serviços funerários — SJC',
  tipoObjeto: ['servicos-funerarios-completos'],
  secretariaDemandante: null,
  valor: { estimado: 500000, sigiloso: false, procedencia: 'termo-referencia' },
  moeda: 'BRL',
  criterioJulgamento: 'menor-preco',
  agrupamento: 'lote',
  modoDisputa: 'aberto-fechado',
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
  informacoesViabilidade: 'x',
  pontosDeAtencao: [],
  fonte: { pdfNativo: false, ocr: false, paginas: 1, url: null },
});

const oficio: OficioGerado = {
  tipo: 'esclarecimento',
  markdown: '# Ofício\n\nQual a vigência?',
  leisCitadas: [],
};

function registro(over: Partial<AnaliseRegistro> = {}): AnaliseRegistro {
  return {
    id: 'a-99',
    jobId: 'job-99',
    municipio: 'São José dos Campos',
    uf: 'SP',
    extracao,
    oficioGerado: oficio,
    oficioExportado: '# Ofício EDITADO\n\nQual a vigência da Lei 14.133?',
    oficioExportadoEm: new Date('2026-05-19T10:00:00Z'),
    ...over,
  };
}

function fakeRepo(r: AnaliseRegistro | null): AnalysisRepo {
  return {
    async salvar() {
      throw new Error('n/a');
    },
    async buscarPorId(id) {
      return r && r.id === id ? r : null;
    },
    async buscarPorJobId() {
      return r;
    },
    async registrarOficioExportado() {
      throw new Error('n/a');
    },
    async listarRecentes() {
      return r ? [r] : [];
    },
  };
}

describe('promoverParaCorpus — 1 passo p/ fixtures/gold (§11b)', () => {
  it('escreve em fixtures/gold/ com slug de município/uf + JSON válido de Tier 0', async () => {
    const escritos: Array<{ caminho: string; conteudo: string }> = [];
    const res = await promoverParaCorpus('a-99', {
      analysisRepo: fakeRepo(registro()),
      escrever: async (caminho, conteudo) => {
        escritos.push({ caminho, conteudo });
      },
      agora: () => new Date('2026-05-19T12:00:00Z'),
    });

    // Caminho: VERSIONADO em fixtures/gold/ (não output/, que é gitignored).
    expect(res.caminho.startsWith(GOLD_DIR)).toBe(true);
    expect(res.caminho).toContain('/fixtures/gold/');
    expect(res.caminho).not.toContain('/output/');
    expect(res.nomeArquivo).toBe('promovido-sao-jose-dos-campos-sp.json');
    expect(escritos).toHaveLength(1);
    expect(escritos[0].caminho).toBe(res.caminho);

    const parsed = JSON.parse(escritos[0].conteudo) as Record<
      string,
      unknown
    >;
    // É uma fixture VÁLIDA de Tier 0: parseia contra o schema (chave
    // `_proveniencia` é stripada pelo Zod → não quebra o safeParse do
    // runner).
    const ok = EditalExtractionSchema.safeParse(parsed);
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.municipio).toBe('São José dos Campos');

    // Proveniência presente p/ auditoria.
    const prov = parsed._proveniencia as Record<string, unknown>;
    expect(prov.analysisId).toBe('a-99');
    expect(prov.jobId).toBe('job-99');
    expect(prov.temOficioGerado).toBe(true);
    expect(prov.oficioFoiEditado).toBe(true);
    expect(prov.promovidoEm).toBe('2026-05-19T12:00:00.000Z');
  });

  it('análise inexistente → lança (1 passo exige algo persistido)', async () => {
    await expect(
      promoverParaCorpus('nao-existe', {
        analysisRepo: fakeRepo(null),
        escrever: async () => {},
      })
    ).rejects.toThrow(/não encontrada/);
  });

  it('slugFixture: normaliza acentos/espaços/símbolos', () => {
    expect(slugFixture('Dom Basílio', 'BA')).toBe('dom-basilio-ba');
    expect(slugFixture('Mata Grande', 'AL')).toBe('mata-grande-al');
    expect(slugFixture('', '')).toBe('analise');
  });
});
