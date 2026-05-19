import { describe, it, expect } from 'vitest';
import { listarAdmin } from './handler.ts';
import { EditalExtractionSchema } from '../../domain/schema.ts';
import type {
  AnaliseRegistro,
  AnalysisRepo,
  EventoTelemetria,
  OficioGerado,
  TelemetryPort,
} from '../../domain/ports.ts';

/**
 * Testes DETERMINÍSTICOS da superfície /admin (§11b). Fakes in-memory —
 * sem Postgres. Provam: sinal-ouro (diff) por linha; feedback resolvido;
 * fallback (exportou) quando diff vazio; re-upload por hash repetido.
 */

const extracao = EditalExtractionSchema.parse({
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

const oficio: OficioGerado = {
  tipo: 'esclarecimento',
  markdown: '# Ofício\n\nQual a vigência?',
  leisCitadas: [],
};

function reg(over: Partial<AnaliseRegistro>): AnaliseRegistro {
  return {
    id: 'a-1',
    jobId: 'job-1',
    municipio: 'Jaborandi',
    uf: 'BA',
    extracao,
    oficioGerado: oficio,
    oficioExportado: null,
    oficioExportadoEm: null,
    ...over,
  };
}

function repo(rs: AnaliseRegistro[]): AnalysisRepo {
  return {
    async salvar() {
      throw new Error('n/a');
    },
    async buscarPorId(id) {
      return rs.find((r) => r.id === id) ?? null;
    },
    async buscarPorJobId() {
      return null;
    },
    async registrarOficioExportado() {
      throw new Error('n/a');
    },
    async listarRecentes(l = 50) {
      return rs.slice(0, l);
    },
  };
}

function tele(eventos: EventoTelemetria[]): TelemetryPort {
  return {
    async registrar() {},
    async listarPorAnalises(ids) {
      return eventos.filter((e) => ids.includes(e.analysisId));
    },
  };
}

function ev(
  analysisId: string,
  evento: string,
  payload: Record<string, unknown>
): EventoTelemetria {
  return { analysisId, evento, payload, createdAt: new Date(0) };
}

describe('listarAdmin — revisão interna (§11b)', () => {
  it('sinal-ouro: ofício exportado ≠ gerado → foiEditado + distância', async () => {
    const r = reg({
      id: 'a-1',
      oficioExportado: '# Ofício EDITADO\n\nQual a vigência da Lei?',
      oficioExportadoEm: new Date('2026-05-19T10:00:00Z'),
    });
    const linhas = await listarAdmin({
      analysisRepo: repo([r]),
      telemetry: tele([
        ev('a-1', 'export', { tipo: 'oficio', foiEditado: true }),
        ev('a-1', 'feedback', { util: true, texto: 'ótimo' }),
      ]),
    });
    expect(linhas).toHaveLength(1);
    expect(linhas[0].municipio).toBe('Jaborandi');
    expect(linhas[0].oficioFoiEditado).toBe(true);
    expect(linhas[0].diffDistancia).toBeGreaterThan(0);
    expect(linhas[0].exportouOficio).toBe(true);
    expect(linhas[0].feedback).toEqual({ util: true, texto: 'ótimo' });
  });

  it('FALLBACK: sem edição → sinal-ouro nulo; reserva (exportou) presente', async () => {
    const r = reg({
      id: 'a-2',
      jobId: 'job-2',
      oficioExportado: oficio.markdown, // exportou SEM editar
      oficioExportadoEm: new Date('2026-05-19T11:00:00Z'),
    });
    const linhas = await listarAdmin({
      analysisRepo: repo([r]),
      telemetry: tele([ev('a-2', 'export', { tipo: 'oficio' })]),
    });
    expect(linhas[0].oficioFoiEditado).toBe(false); // ouro nulo
    expect(linhas[0].diffDistancia).toBe(0);
    expect(linhas[0].exportouOficio).toBe(true); // reserva
    expect(linhas[0].feedback).toBeNull();
  });

  it('RE-UPLOAD: mesmo inputHash em 2 análises → reupload=true em ambas', async () => {
    const a = reg({ id: 'a-1', jobId: 'job-1' });
    const b = reg({ id: 'a-2', jobId: 'job-2' });
    const linhas = await listarAdmin({
      analysisRepo: repo([a, b]),
      telemetry: tele([
        ev('a-1', 'submissao', { inputHash: 'deadbeef' }),
        ev('a-2', 'submissao', { inputHash: 'deadbeef' }),
      ]),
    });
    expect(linhas.every((l) => l.reupload)).toBe(true);
  });

  it('hash único → reupload=false', async () => {
    const a = reg({ id: 'a-1' });
    const linhas = await listarAdmin({
      analysisRepo: repo([a]),
      telemetry: tele([ev('a-1', 'submissao', { inputHash: 'abc12345' })]),
    });
    expect(linhas[0].reupload).toBe(false);
  });
});
