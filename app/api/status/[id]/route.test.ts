import { describe, it, expect } from 'vitest';
import { criarStatusGET } from './handler.ts';
import { EditalExtractionSchema } from '../../../../domain/schema.ts';
import type {
  AnaliseRegistro,
  AnalysisRepo,
  Job,
  JobRepo,
} from '../../../../domain/ports.ts';

/**
 * Testes DETERMINÍSTICOS de /api/status/:id — reflete o estado do Job e,
 * quando `done`, devolve a análise persistida. Sem servidor/Postgres.
 */

function jobs(...js: Job[]): JobRepo {
  return {
    async criar() {
      throw new Error('n/a');
    },
    async claimNext() {
      return null;
    },
    async marcarConcluido() {},
    async marcarErro() {},
    async buscarPorId(id) {
      return js.find((j) => j.id === id) ?? null;
    },
  };
}

function analyses(...rs: AnaliseRegistro[]): AnalysisRepo {
  return {
    async salvar() {
      throw new Error('n/a');
    },
    async buscarPorId(id) {
      return rs.find((r) => r.id === id) ?? null;
    },
    async buscarPorJobId(jobId) {
      return rs.find((r) => r.jobId === jobId) ?? null;
    },
    async registrarOficioExportado() {
      throw new Error('n/a');
    },
    async listarRecentes() {
      return [...rs];
    },
  };
}

const extracaoMin = EditalExtractionSchema.parse({
  municipio: 'Jaborandi',
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

function req(): Request {
  return new Request('http://localhost/api/status/x');
}

describe('GET /api/status/:id', () => {
  it('pending: status pending, no result', async () => {
    const GET = criarStatusGET({
      jobRepo: jobs({
        id: 'j1',
        status: 'pending',
        erro: null,
        inputRef: '{}',
        createdAt: new Date(),
      }),
      analysisRepo: analyses(),
    });
    const res = await GET(req(), { params: Promise.resolve({ id: 'j1' }) });
    expect(res.status).toBe(200);
    const b = (await res.json()) as { status: string; resultado: unknown };
    expect(b.status).toBe('pending');
    expect(b.resultado).toBeNull();
  });

  it('running: reflects running', async () => {
    const GET = criarStatusGET({
      jobRepo: jobs({
        id: 'j2',
        status: 'running',
        erro: null,
        inputRef: '{}',
        createdAt: new Date(),
      }),
      analysisRepo: analyses(),
    });
    const res = await GET(req(), { params: Promise.resolve({ id: 'j2' }) });
    expect((await res.json()).status).toBe('running');
  });

  it('done: returns the persisted analysis', async () => {
    const GET = criarStatusGET({
      jobRepo: jobs({
        id: 'j3',
        status: 'done',
        erro: null,
        inputRef: '{}',
        createdAt: new Date(),
      }),
      analysisRepo: analyses({
        id: 'a3',
        jobId: 'j3',
        municipio: 'Jaborandi',
        uf: 'BA',
        extracao: extracaoMin,
        oficioGerado: null,
        oficioExportado: null,
        oficioExportadoEm: null,
      }),
    });
    const res = await GET(req(), { params: Promise.resolve({ id: 'j3' }) });
    const b = (await res.json()) as {
      status: string;
      resultado: { extracao: { municipio: string } } | null;
    };
    expect(b.status).toBe('done');
    expect(b.resultado).not.toBeNull();
    expect(b.resultado!.extracao.municipio).toBe('Jaborandi');
  });

  it('erro: returns the persisted message', async () => {
    const GET = criarStatusGET({
      jobRepo: jobs({
        id: 'j4',
        status: 'erro',
        erro: 'preprocessor: zip-bomb rejeitado',
        inputRef: '{}',
        createdAt: new Date(),
      }),
      analysisRepo: analyses(),
    });
    const res = await GET(req(), { params: Promise.resolve({ id: 'j4' }) });
    const b = (await res.json()) as { status: string; erro: string };
    expect(b.status).toBe('erro');
    expect(b.erro).toMatch(/zip-bomb/);
  });

  it('nonexistent job: 404', async () => {
    const GET = criarStatusGET({
      jobRepo: jobs(),
      analysisRepo: analyses(),
    });
    const res = await GET(req(), {
      params: Promise.resolve({ id: 'nao-existe' }),
    });
    expect(res.status).toBe(404);
  });
});
