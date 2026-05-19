import { describe, it, expect } from 'vitest';
import { criarFeedbackPOST } from './handler.ts';
import { EditalExtractionSchema } from '../../../../domain/schema.ts';
import type {
  AnaliseRegistro,
  AnalysisRepo,
  TelemetryPort,
} from '../../../../domain/ports.ts';

/**
 * Testes DETERMINÍSTICOS de POST /api/feedback/:jobId — feedback explícito
 * mínimo (§11b). Sem servidor/Postgres (testing-anti-patterns). Provam:
 * 👍/👎 → telemetria `feedback`; texto opcional; 404 sem análise;
 * validação do booleano; NÃO-bloqueante (telemetria que lança ≠ 5xx).
 */

const extracao = EditalExtractionSchema.parse({
  municipio: 'Niterói',
  uf: 'RJ',
  ente: { tipo: 'prefeitura', razaoSocial: 'PMN', cnpj: null },
  modalidade: 'pregao-eletronico',
  numero: '9/2026',
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

function registro(): AnaliseRegistro {
  return {
    id: 'a1',
    jobId: 'job-1',
    municipio: 'Niterói',
    uf: 'RJ',
    extracao,
    oficioGerado: null,
    oficioExportado: null,
    oficioExportadoEm: null,
  };
}

function fakeRepo(r: AnaliseRegistro | null): AnalysisRepo {
  return {
    async salvar() {
      throw new Error('n/a');
    },
    async buscarPorId() {
      return r;
    },
    async buscarPorJobId(jobId) {
      return r && r.jobId === jobId ? r : null;
    },
    async registrarOficioExportado() {
      throw new Error('n/a');
    },
    async listarRecentes() {
      return r ? [r] : [];
    },
  };
}

function fakeTelemetry(): TelemetryPort & {
  eventos: Array<{
    analysisId: string;
    evento: string;
    payload: Record<string, unknown>;
  }>;
} {
  const eventos: Array<{
    analysisId: string;
    evento: string;
    payload: Record<string, unknown>;
  }> = [];
  return {
    eventos,
    async registrar(analysisId, evento, payload) {
      eventos.push({ analysisId, evento, payload });
    },
    async listarPorAnalises() {
      return [];
    },
  };
}

function req(body: unknown): Request {
  return new Request('http://localhost/api/feedback/job-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ctx = (jobId = 'job-1') => ({
  params: Promise.resolve({ jobId }),
});

describe('POST /api/feedback/:jobId', () => {
  it('👍 com texto → telemetria feedback {util:true, texto}', async () => {
    const tele = fakeTelemetry();
    const POST = criarFeedbackPOST({
      analysisRepo: fakeRepo(registro()),
      telemetry: tele,
    });
    const res = await POST(
      req({ util: true, texto: '  muito útil  ' }),
      ctx()
    );
    expect(res.status).toBe(202);
    expect(tele.eventos).toEqual([
      {
        analysisId: 'a1',
        evento: 'feedback',
        payload: { util: true, texto: 'muito útil' },
      },
    ]);
  });

  it('👎 sem texto → telemetria feedback {util:false, texto:null}', async () => {
    const tele = fakeTelemetry();
    const POST = criarFeedbackPOST({
      analysisRepo: fakeRepo(registro()),
      telemetry: tele,
    });
    const res = await POST(req({ util: false }), ctx());
    expect(res.status).toBe(202);
    expect(tele.eventos[0].payload).toEqual({
      util: false,
      texto: null,
    });
  });

  it('util ausente / não-boolean → 400 (nada gravado)', async () => {
    const tele = fakeTelemetry();
    const POST = criarFeedbackPOST({
      analysisRepo: fakeRepo(registro()),
      telemetry: tele,
    });
    const res = await POST(req({ texto: 'só texto' }), ctx());
    expect(res.status).toBe(400);
    expect(tele.eventos).toHaveLength(0);
  });

  it('análise inexistente → 404', async () => {
    const POST = criarFeedbackPOST({
      analysisRepo: fakeRepo(null),
      telemetry: fakeTelemetry(),
    });
    const res = await POST(req({ util: true }), ctx('nao-existe'));
    expect(res.status).toBe(404);
  });

  it('telemetria que LANÇA NÃO vira 5xx (feedback é reserva — §11b)', async () => {
    const POST = criarFeedbackPOST({
      analysisRepo: fakeRepo(registro()),
      telemetry: {
        async registrar() {
          throw new Error('telemetria DB caiu');
        },
        async listarPorAnalises() {
          return [];
        },
      },
    });
    const res = await POST(req({ util: true }), ctx());
    expect(res.status).toBe(202);
  });
});
