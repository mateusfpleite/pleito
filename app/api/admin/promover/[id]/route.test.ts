import { describe, it, expect } from 'vitest';
import { criarPromoverPOST } from './handler.ts';
import { EditalExtractionSchema } from '../../../../../domain/schema.ts';
import type {
  AnaliseRegistro,
  AnalysisRepo,
} from '../../../../../domain/ports.ts';

/**
 * DETERMINISTIC tests of the 1-step promote-to-corpus endpoint (§11b).
 * Injected writer (no real fs). They prove: 201 + file name + wrote to
 * fixtures/gold/; 404 if the analysis does not exist.
 */

const extracao = EditalExtractionSchema.parse({
  municipio: 'Dom Basílio',
  uf: 'BA',
  ente: { tipo: 'prefeitura', razaoSocial: 'X', cnpj: null },
  modalidade: 'pregao-eletronico',
  numero: '1/2026',
  processoAdministrativo: null,
  dataPublicacao: null,
  dataSessao: null,
  uasg: null,
  regimeJuridico: 'lei-14133',
  objetoCorpo: 'Serviços',
  objetoCapa: null,
  objetoSummary: 'Serviços',
  tipoObjeto: ['servicos-funerarios-completos'],
  secretariaDemandante: null,
  valor: { estimado: null, sigiloso: true, procedencia: 'preambulo' },
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

function reg(): AnaliseRegistro {
  return {
    id: 'a-7',
    jobId: 'job-7',
    municipio: 'Dom Basílio',
    uf: 'BA',
    extracao,
    oficioGerado: null,
    oficioExportado: null,
    oficioExportadoEm: null,
  };
}

function repo(r: AnaliseRegistro | null): AnalysisRepo {
  return {
    async salvar() {
      throw new Error('n/a');
    },
    async buscarPorId(id) {
      return r && r.id === id ? r : null;
    },
    async buscarPorJobId() {
      return null;
    },
    async registrarOficioExportado() {
      throw new Error('n/a');
    },
    async listarRecentes() {
      return r ? [r] : [];
    },
  };
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request('http://localhost/api/admin/promover/a-7');

describe('POST /api/admin/promover/:id', () => {
  it('promotes → 201 + nomeArquivo + wrote to fixtures/gold/', async () => {
    const escritos: string[] = [];
    const POST = criarPromoverPOST({
      analysisRepo: repo(reg()),
      promoverOpts: {
        escrever: async (caminho) => {
          escritos.push(caminho);
        },
        agora: () => new Date('2026-05-19T12:00:00Z'),
      },
    });
    const res = await POST(req(), ctx('a-7'));
    expect(res.status).toBe(201);
    const b = (await res.json()) as { nomeArquivo: string };
    expect(b.nomeArquivo).toBe('promovido-dom-basilio-ba.json');
    expect(escritos[0]).toContain('/fixtures/gold/');
    expect(escritos[0]).not.toContain('/output/');
  });

  it('nonexistent analysis → 404', async () => {
    const POST = criarPromoverPOST({
      analysisRepo: repo(null),
      promoverOpts: { escrever: async () => {} },
    });
    const res = await POST(req(), ctx('nao-existe'));
    expect(res.status).toBe(404);
  });
});
