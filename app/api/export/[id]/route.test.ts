import { describe, it, expect } from 'vitest';
import { criarExportPOST } from './handler.ts';
import { EditalExtractionSchema } from '../../../../domain/schema.ts';
import type {
  AnaliseRegistro,
  AnalysisRepo,
  OficioGerado,
  TelemetryPort,
} from '../../../../domain/ports.ts';
import type { PdfEngine } from '../../../../adapters/pdf/render.ts';

/** In-memory fake telemetria — captures events for assertion (§11b). */
function fakeTelemetry(): TelemetryPort & {
  eventos: Array<{ evento: string; payload: Record<string, unknown> }>;
} {
  const eventos: Array<{
    evento: string;
    payload: Record<string, unknown>;
  }> = [];
  return {
    eventos,
    async registrar(_id, evento, payload) {
      eventos.push({ evento, payload });
    },
    async listarPorAnalises() {
      return [];
    },
  };
}

/**
 * DETERMINISTIC tests of POST /api/export/:jobId. No chromium (FAKE engine
 * — the binary is worker-runtime RESIDUE, validated in deploy/E2E). They
 * prove the LOGIC: persisting the edited text BEFORE rendering the ofício;
 * relatório as a projection of the JSON; 404; HTTP contract.
 */

const extracaoMin = EditalExtractionSchema.parse({
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
  objetoSummary: 'Serviços funerários — Niterói',
  tipoObjeto: ['servicos-funerarios-completos'],
  secretariaDemandante: null,
  valor: { estimado: null, sigiloso: true, procedencia: 'sigiloso' },
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

const OFICIO_GERADO_JSON: OficioGerado = {
  tipo: 'esclarecimento',
  // ORIGINAL Drafter text — must NOT appear in the ofício PDF if Stefany
  // edited it (the central proof of §9).
  markdown:
    '# Ofício GERADO pelo robô\n\nTexto automático que será SUBSTITUÍDO.',
  leisCitadas: [],
};

/**
 * Fake repo that records the persisted text and separates what is WRITTEN
 * vs. what is in `oficioGerado` (JSON). `registrarOficioExportado` mirrors
 * the real Prisma: writes `oficioExportado`+`oficioExportadoEm`.
 */
function fakeRepo(registro: AnaliseRegistro | null): AnalysisRepo & {
  persistidoOficio: string | null;
} {
  let atual = registro;
  return {
    persistidoOficio: null,
    async salvar() {
      throw new Error('n/a');
    },
    async buscarPorId() {
      return atual;
    },
    async buscarPorJobId(jobId) {
      return atual && atual.jobId === jobId ? atual : null;
    },
    async registrarOficioExportado(id, texto) {
      if (!atual || atual.id !== id) {
        throw new Error(`análise ${id} inexistente`);
      }
      atual = {
        ...atual,
        oficioExportado: texto,
        oficioExportadoEm: new Date('2026-05-19T12:00:00Z'),
      };
      // mirrors the persisted state for assertion
      (this as { persistidoOficio: string | null }).persistidoOficio =
        texto;
      return atual;
    },
    async listarRecentes() {
      return atual ? [atual] : [];
    },
  };
}

/** Fake engine: returns %PDF and records the received HTML. */
function fakeEngine(): PdfEngine & { htmlVisto: string[] } {
  const htmlVisto: string[] = [];
  return {
    htmlVisto,
    async htmlParaPdf(html) {
      htmlVisto.push(html);
      return Buffer.from(`%PDF-1.4 ${html.length}`);
    },
  };
}

function registroBase(): AnaliseRegistro {
  return {
    id: 'a1',
    jobId: 'job-1',
    municipio: 'Niterói',
    uf: 'RJ',
    extracao: extracaoMin,
    oficioGerado: OFICIO_GERADO_JSON,
    oficioExportado: null,
    oficioExportadoEm: null,
  };
}

function req(body: unknown): Request {
  return new Request('http://localhost/api/export/job-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ctx = (id = 'job-1') => ({ params: Promise.resolve({ id }) });

describe('POST /api/export/:jobId', () => {
  it('oficio: PERSISTS the edited text and renders FROM the persisted one (NOT from the JSON) — §9', async () => {
    const repo = fakeRepo(registroBase());
    const eng = fakeEngine();
    const tele = fakeTelemetry();
    const POST = criarExportPOST({
      analysisRepo: repo,
      pdfEngine: eng,
      telemetry: tele,
    });

    const TEXTO_EDITADO =
      '# Ofício EDITADO pela Stefany\n\n' +
      'Solicita-se esclarecimento sobre a vigência da norma.';

    const res = await POST(
      req({ tipo: 'oficio', textoOficio: TEXTO_EDITADO }),
      ctx()
    );

    expect(res.status).toBe(200);
    // (1) the edited text was PERSISTED via the repo (oficioExportado).
    expect(repo.persistidoOficio).toBe(TEXTO_EDITADO);
    // (2) the PDF was rendered FROM the persisted/edited text...
    const html = eng.htmlVisto[0];
    expect(html).toContain('<h1>Ofício EDITADO pela Stefany</h1>');
    expect(html).toContain(
      '<p>Solicita-se esclarecimento sobre a vigência da norma.</p>'
    );
    // ...and did NOT regenerate from the original JSON (oficioGerado.markdown).
    expect(html).not.toContain('Ofício GERADO pelo robô');
    expect(html).not.toContain('Texto automático que será SUBSTITUÍDO');

    // GOLD SIGNAL (§11b): edited → oficio_diff with sinalOuro=true +
    // oficio_editado + export. The generated markdown was PRESERVED for
    // the diff.
    const tipos = tele.eventos.map((x) => x.evento);
    expect(tipos).toContain('oficio_diff');
    expect(tipos).toContain('oficio_editado');
    expect(tipos).toContain('export');
    const diffEv = tele.eventos.find((x) => x.evento === 'oficio_diff')!;
    expect(diffEv.payload.sinalOuro).toBe(true);
    expect(diffEv.payload.foiEditado).toBe(true);
    expect(
      diffEv.payload.distanciaCaracteres as number
    ).toBeGreaterThan(0);
    expect(diffEv.payload.exportou).toBe(true); // fallback also present
  });

  it('oficio WITHOUT edit → FALLBACK: oficio_diff sinalOuro=false, no oficio_editado, fallback exportou=true (§11b)', async () => {
    const repo = fakeRepo(registroBase());
    const tele = fakeTelemetry();
    const POST = criarExportPOST({
      analysisRepo: repo,
      pdfEngine: fakeEngine(),
      telemetry: tele,
    });
    // Exports EXACTLY the generated markdown (accepted without editing) →
    // the gold signal is NULL; the FALLBACK (export-yes) covers it.
    const res = await POST(
      req({
        tipo: 'oficio',
        textoOficio: OFICIO_GERADO_JSON.markdown,
      }),
      ctx()
    );
    expect(res.status).toBe(200);
    const tipos = tele.eventos.map((x) => x.evento);
    expect(tipos).toContain('oficio_diff');
    // empty diff: does NOT emit oficio_editado.
    expect(tipos).not.toContain('oficio_editado');
    const diffEv = tele.eventos.find((x) => x.evento === 'oficio_diff')!;
    expect(diffEv.payload.sinalOuro).toBe(false);
    expect(diffEv.payload.foiEditado).toBe(false);
    // FALLBACK: the fallback (exportou) is the signal available when the
    // gold is null (she accepted without editing).
    expect(diffEv.payload.exportou).toBe(true);
    const exportEv = tele.eventos.find((x) => x.evento === 'export')!;
    expect(exportEv.payload.tipo).toBe('oficio');
    expect(exportEv.payload.foiEditado).toBe(false);
  });

  it('relatorio → export event tipo=relatorio (implicit usage §11b)', async () => {
    const repo = fakeRepo(registroBase());
    const tele = fakeTelemetry();
    const POST = criarExportPOST({
      analysisRepo: repo,
      pdfEngine: fakeEngine(),
      telemetry: tele,
    });
    await POST(req({ tipo: 'relatorio' }), ctx());
    expect(tele.eventos).toEqual([
      { evento: 'export', payload: { tipo: 'relatorio' } },
    ]);
  });

  it('telemetry that THROWS does not break the export (non-blocking §11b)', async () => {
    const repo = fakeRepo(registroBase());
    const POST = criarExportPOST({
      analysisRepo: repo,
      pdfEngine: fakeEngine(),
      telemetry: {
        async registrar() {
          throw new Error('telemetria DB caiu');
        },
        async listarPorAnalises() {
          return [];
        },
      },
    });
    const res = await POST(req({ tipo: 'relatorio' }), ctx());
    // The export still RETURNS 200 — a telemetria failure only logs.
    expect(res.status).toBe(200);
  });

  it('oficio: persists BEFORE rendering (order §9 — no signal loss)', async () => {
    // Failing engine: even so the edited text must have been persisted
    // (persistence is the gold signal §11b, it cannot depend on the
    // success of the derived PDF render).
    const repo = fakeRepo(registroBase());
    const POST = criarExportPOST({
      analysisRepo: repo,
      pdfEngine: {
        async htmlParaPdf() {
          throw new Error('chromium indisponível');
        },
      },
      telemetry: fakeTelemetry(),
    });
    await expect(
      POST(req({ tipo: 'oficio', textoOficio: 'texto final' }), ctx())
    ).rejects.toThrow(/chromium/);
    expect(repo.persistidoOficio).toBe('texto final');
  });

  it('relatorio: projects from the extraction JSON (without writing to the repo)', async () => {
    const repo = fakeRepo(registroBase());
    const eng = fakeEngine();
    const tele = fakeTelemetry();
    const POST = criarExportPOST({
      analysisRepo: repo,
      pdfEngine: eng,
      telemetry: tele,
    });

    const res = await POST(req({ tipo: 'relatorio' }), ctx());

    expect(res.status).toBe(200);
    expect(eng.htmlVisto[0]).toContain('Principais pontos');
    expect(eng.htmlVisto[0]).toContain('Serviços funerários — Niterói');
    // Relatório does NOT persist anything (pure projection, regenerable).
    expect(repo.persistidoOficio).toBeNull();
  });

  it('Content-Type application/pdf + Content-Disposition attachment', async () => {
    const repo = fakeRepo(registroBase());
    const POST = criarExportPOST({
      analysisRepo: repo,
      pdfEngine: fakeEngine(),
      telemetry: fakeTelemetry(),
    });
    const res = await POST(req({ tipo: 'relatorio' }), ctx());
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toMatch(/^attachment;/);
    expect(cd).toContain('.pdf');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('nonexistent job / no analysis → 404', async () => {
    const repo = fakeRepo(null);
    const POST = criarExportPOST({
      analysisRepo: repo,
      pdfEngine: fakeEngine(),
      telemetry: fakeTelemetry(),
    });
    const res = await POST(req({ tipo: 'relatorio' }), ctx('nao-existe'));
    expect(res.status).toBe(404);
  });

  it('invalid tipo → 400', async () => {
    const repo = fakeRepo(registroBase());
    const POST = criarExportPOST({
      analysisRepo: repo,
      pdfEngine: fakeEngine(),
      telemetry: fakeTelemetry(),
    });
    const res = await POST(req({ tipo: 'planilha' }), ctx());
    expect(res.status).toBe(400);
  });

  it('oficio without textoOficio → 400 (nothing to persist)', async () => {
    const repo = fakeRepo(registroBase());
    const POST = criarExportPOST({
      analysisRepo: repo,
      pdfEngine: fakeEngine(),
      telemetry: fakeTelemetry(),
    });
    const res = await POST(req({ tipo: 'oficio' }), ctx());
    expect(res.status).toBe(400);
    expect(repo.persistidoOficio).toBeNull();
  });
});
