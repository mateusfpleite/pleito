import { describe, it, expect, vi } from 'vitest';
import { drenarFila } from './processar.ts';
import { empacotarInput } from '../infrastructure/input-envelope.ts';
import { EditalExtractionSchema } from '../domain/schema.ts';
import type {
  AnaliseRegistro,
  AnalysisRepo,
  Job,
  JobRepo,
} from '../domain/ports.ts';
import type { AnalyzeResult } from '../application/analyze-edital.ts';

/**
 * Testes DETERMINÍSTICOS do laço de processamento do worker — sem Postgres,
 * sem Gemini, sem servidor HTTP (testing-anti-patterns: provar o
 * comportamento do worker, não a infra). `claimNext` (in-memory) modela o
 * claim atômico; `analyzeEdital` é injetado como fake.
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

function fakeJobRepo(): JobRepo & {
  jobs: Job[];
  add: (inputRef: string) => Job;
} {
  const jobs: Job[] = [];
  let seq = 0;
  return {
    jobs,
    add(inputRef: string) {
      const j: Job = {
        id: `job-${++seq}`,
        status: 'pending',
        erro: null,
        inputRef,
        createdAt: new Date(2026, 4, 19, 0, 0, seq),
      };
      jobs.push(j);
      return j;
    },
    async criar() {
      throw new Error('n/a');
    },
    async claimNext() {
      const p = jobs
        .filter((j) => j.status === 'pending')
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
      if (!p) return null;
      p.status = 'running'; // atômico no fake (1 thread JS)
      return { ...p };
    },
    async marcarConcluido(id) {
      const j = jobs.find((x) => x.id === id);
      if (j) {
        j.status = 'done';
        j.erro = null;
      }
    },
    async marcarErro(id, erro) {
      const j = jobs.find((x) => x.id === id);
      if (j) {
        j.status = 'erro';
        j.erro = erro;
      }
    },
    async buscarPorId(id) {
      return jobs.find((j) => j.id === id) ?? null;
    },
  };
}

function fakeAnalysisRepo(): AnalysisRepo & { saved: AnaliseRegistro[] } {
  const saved: AnaliseRegistro[] = [];
  let seq = 0;
  return {
    saved,
    async salvar(r) {
      const full = { ...r, id: `a-${++seq}` };
      saved.push(full);
      return full;
    },
    async buscarPorId(id) {
      return saved.find((r) => r.id === id) ?? null;
    },
    async buscarPorJobId(jobId) {
      return saved.find((r) => r.jobId === jobId) ?? null;
    },
    async registrarOficioExportado(id, texto) {
      const r = saved.find((x) => x.id === id);
      if (!r) throw new Error(`análise ${id} inexistente`);
      r.oficioExportado = texto;
      r.oficioExportadoEm = new Date();
      return r;
    },
  };
}

const okResult: AnalyzeResult = { extracao, oficio: null };

describe('drenarFila (laço do worker)', () => {
  it('processa 1 job: analyze → grava Analysis → Job done', async () => {
    const jobRepo = fakeJobRepo();
    const analysisRepo = fakeAnalysisRepo();
    jobRepo.add(empacotarInput('e.txt', new TextEncoder().encode('EDITAL')));
    const analyze = vi.fn(async () => okResult);

    await drenarFila({ jobRepo, analysisRepo, analyze });

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(jobRepo.jobs[0].status).toBe('done');
    expect(analysisRepo.saved).toHaveLength(1);
    expect(analysisRepo.saved[0].jobId).toBe('job-1');
    expect(analysisRepo.saved[0].municipio).toBe('Jaborandi');
    expect(analysisRepo.saved[0].uf).toBe('BA');
  });

  it('drena a fila inteira (vários pending) e para quando vazia', async () => {
    const jobRepo = fakeJobRepo();
    const analysisRepo = fakeAnalysisRepo();
    jobRepo.add(empacotarInput('a.txt', new TextEncoder().encode('A')));
    jobRepo.add(empacotarInput('b.txt', new TextEncoder().encode('B')));
    jobRepo.add(empacotarInput('c.txt', new TextEncoder().encode('C')));
    const analyze = vi.fn(async () => okResult);

    await drenarFila({ jobRepo, analysisRepo, analyze });

    expect(analyze).toHaveBeenCalledTimes(3);
    expect(jobRepo.jobs.every((j) => j.status === 'done')).toBe(true);
    expect(analysisRepo.saved).toHaveLength(3);
  });

  it('erro no pipeline → Job erro com a mensagem, NÃO grava Analysis', async () => {
    const jobRepo = fakeJobRepo();
    const analysisRepo = fakeAnalysisRepo();
    jobRepo.add(empacotarInput('e.txt', new TextEncoder().encode('X')));
    const analyze = vi.fn(async () => {
      throw new Error('Tier 0: violação de contenção estrutural');
    });

    await drenarFila({ jobRepo, analysisRepo, analyze });

    expect(jobRepo.jobs[0].status).toBe('erro');
    expect(jobRepo.jobs[0].erro).toMatch(/Tier 0/);
    expect(analysisRepo.saved).toHaveLength(0); // sem doc parcial
  });

  it('erro num job NÃO derruba o laço: o próximo é processado', async () => {
    const jobRepo = fakeJobRepo();
    const analysisRepo = fakeAnalysisRepo();
    jobRepo.add(empacotarInput('ruim.txt', new TextEncoder().encode('1')));
    jobRepo.add(empacotarInput('bom.txt', new TextEncoder().encode('2')));
    const analyze = vi
      .fn<() => Promise<AnalyzeResult>>()
      .mockRejectedValueOnce(new Error('preprocessor: zip-bomb'))
      .mockResolvedValueOnce(okResult);

    await drenarFila({ jobRepo, analysisRepo, analyze });

    expect(jobRepo.jobs[0].status).toBe('erro');
    expect(jobRepo.jobs[0].erro).toMatch(/zip-bomb/);
    expect(jobRepo.jobs[1].status).toBe('done');
    expect(analysisRepo.saved).toHaveLength(1);
  });

  it('fila vazia: não faz nada (claimNext → null)', async () => {
    const jobRepo = fakeJobRepo();
    const analysisRepo = fakeAnalysisRepo();
    const analyze = vi.fn(async () => okResult);
    await drenarFila({ jobRepo, analysisRepo, analyze });
    expect(analyze).not.toHaveBeenCalled();
  });
});
