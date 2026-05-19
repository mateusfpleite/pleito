import { describe, it, expect, vi } from 'vitest';
import { drenarFila } from './processar.ts';
import { empacotarInput } from '../infrastructure/input-envelope.ts';
import { EditalExtractionSchema } from '../domain/schema.ts';
import type {
  AnaliseRegistro,
  AnalysisRepo,
  Job,
  JobRepo,
  TelemetryPort,
} from '../domain/ports.ts';
import type { AnalyzeResult } from '../application/analyze-edital.ts';

/**
 * DETERMINISTIC tests of the worker processing loop — no Postgres, no
 * Gemini, no HTTP server (testing-anti-patterns: prove the worker's
 * behavior, not the infra). `claimNext` (in-memory) models the atomic
 * claim; `analyzeEdital` is injected as a fake.
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
      p.status = 'running'; // atomic in the fake (1 JS thread)
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
    async listarRecentes() {
      return [...saved].reverse();
    },
  };
}

const okResult: AnalyzeResult = { extracao, oficio: null };

describe('drenarFila (worker loop)', () => {
  it('processes 1 job: analyze → writes Analysis → Job done', async () => {
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

  it('drains the entire queue (several pending) and stops when empty', async () => {
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

  it('pipeline error → Job erro with the message, does NOT write Analysis', async () => {
    const jobRepo = fakeJobRepo();
    const analysisRepo = fakeAnalysisRepo();
    jobRepo.add(empacotarInput('e.txt', new TextEncoder().encode('X')));
    const analyze = vi.fn(async () => {
      throw new Error('Tier 0: violação de contenção estrutural');
    });

    await drenarFila({ jobRepo, analysisRepo, analyze });

    expect(jobRepo.jobs[0].status).toBe('erro');
    expect(jobRepo.jobs[0].erro).toMatch(/Tier 0/);
    expect(analysisRepo.saved).toHaveLength(0); // no partial doc
  });

  it('an error in one job does NOT break the loop: the next one is processed', async () => {
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

  it('empty queue: does nothing (claimNext → null)', async () => {
    const jobRepo = fakeJobRepo();
    const analysisRepo = fakeAnalysisRepo();
    const analyze = vi.fn(async () => okResult);
    await drenarFila({ jobRepo, analysisRepo, analyze });
    expect(analyze).not.toHaveBeenCalled();
  });
});

/**
 * SPEC §11b (Phase 15) — worker observability. Fake in-memory telemetria;
 * no Postgres/LLM (testing-anti-patterns). Invariants:
 *  - 1 `grounding_custo` event PER grounding call (NOT just aggregated),
 *    attributed to the real analysisId (after the save);
 *  - `analise_concluida` with latency (injected clock) + aggregate;
 *  - NON-blocking telemetria: an adapter that THROWS does not bring down
 *    the job.
 */
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
    async listarPorAnalises(ids) {
      return eventos
        .filter((e) => ids.includes(e.analysisId))
        .map((e) => ({ ...e, createdAt: new Date(0) }));
    },
  };
}

describe('drenarFila — observability telemetry (§11b)', () => {
  it('grounding: 1 cost event PER call + analise_concluida with latency', async () => {
    const jobRepo = fakeJobRepo();
    const analysisRepo = fakeAnalysisRepo();
    const tele = fakeTelemetry();
    jobRepo.add(empacotarInput('e.txt', new TextEncoder().encode('E')));

    // The fake `analyze` simulates 2 grounding calls via the sink that
    // `drenarFila` injects — exactly as the real Verifier would.
    const analyze = vi.fn(
      async (
        _input,
        onGroundingCusto?: (u: {
          lei: string;
          inputTokens: number | undefined;
          outputTokens: number | undefined;
          totalTokens: number | undefined;
        }) => void
      ) => {
        onGroundingCusto?.({
          lei: '1234/2001',
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
        });
        onGroundingCusto?.({
          lei: '5678/2002',
          inputTokens: 80,
          outputTokens: 10,
          totalTokens: undefined,
        });
        return okResult;
      }
    );

    // Injected clock: 1st reading=1000, 2nd=1000+90000 → 90s latency.
    const leituras = [1000, 91_000];
    let i = 0;
    await drenarFila({
      jobRepo,
      analysisRepo,
      analyze,
      telemetry: tele,
      agora: () => leituras[i++],
    });

    const analysisId = analysisRepo.saved[0].id;
    const custos = tele.eventos.filter(
      (e) => e.evento === 'grounding_custo'
    );
    // 1 event PER call (not aggregated into one) — the central proof §11b.
    expect(custos).toHaveLength(2);
    expect(custos.every((c) => c.analysisId === analysisId)).toBe(true);
    expect(custos.map((c) => c.payload.lei).sort()).toEqual([
      '1234/2001',
      '5678/2002',
    ]);
    // 2nd call without totalTokens → sums input+output (80+10=90).
    const c2 = custos.find((c) => c.payload.lei === '5678/2002')!;
    expect(c2.payload.totalTokens).toBe(90);
    expect(c2.payload.estimativa).toBe(true);

    const concl = tele.eventos.find(
      (e) => e.evento === 'analise_concluida'
    )!;
    expect(concl.analysisId).toBe(analysisId);
    expect(concl.payload.latenciaMs).toBe(90_000);
    expect(concl.payload.groundingChamadas).toBe(2);
    expect(concl.payload.groundingTokensTotais).toBe(210); // 120 + 90
  });

  it('without grounding: only analise_concluida (0 cost events)', async () => {
    const jobRepo = fakeJobRepo();
    const analysisRepo = fakeAnalysisRepo();
    const tele = fakeTelemetry();
    jobRepo.add(empacotarInput('e.txt', new TextEncoder().encode('E')));
    await drenarFila({
      jobRepo,
      analysisRepo,
      analyze: vi.fn(async () => okResult),
      telemetry: tele,
      agora: () => 0,
    });
    expect(
      tele.eventos.filter((e) => e.evento === 'grounding_custo')
    ).toHaveLength(0);
    const concl = tele.eventos.find(
      (e) => e.evento === 'analise_concluida'
    )!;
    expect(concl.payload.groundingChamadas).toBe(0);
  });

  it('telemetry that THROWS does not break the job (non-blocking §11b)', async () => {
    const jobRepo = fakeJobRepo();
    const analysisRepo = fakeAnalysisRepo();
    jobRepo.add(empacotarInput('e.txt', new TextEncoder().encode('E')));
    const tele: TelemetryPort = {
      async registrar() {
        throw new Error('telemetria DB caiu');
      },
      async listarPorAnalises() {
        return [];
      },
    };
    await drenarFila({
      jobRepo,
      analysisRepo,
      analyze: vi.fn(async () => okResult),
      telemetry: tele,
      agora: () => 0,
    });
    // The job COMPLETED even with the telemetria failing.
    expect(jobRepo.jobs[0].status).toBe('done');
    expect(analysisRepo.saved).toHaveLength(1);
  });
});
