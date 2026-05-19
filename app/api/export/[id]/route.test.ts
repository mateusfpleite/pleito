import { describe, it, expect } from 'vitest';
import { criarExportPOST } from './handler.ts';
import { EditalExtractionSchema } from '../../../../domain/schema.ts';
import type {
  AnaliseRegistro,
  AnalysisRepo,
  OficioGerado,
} from '../../../../domain/ports.ts';
import type { PdfEngine } from '../../../../adapters/pdf/render.ts';

/**
 * Testes DETERMINÍSTICOS de POST /api/export/:jobId. Sem chromium (engine
 * FAKE — o binário é RESÍDUO de runtime do worker, validado em
 * deploy/E2E). Provam a LÓGICA: persistência do texto editado ANTES da
 * render do ofício; relatório como projeção do JSON; 404; contrato HTTP.
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
  // Texto ORIGINAL do Drafter — NÃO deve aparecer no PDF do ofício se a
  // Stefany editou (a prova central do §9).
  markdown:
    '# Ofício GERADO pelo robô\n\nTexto automático que será SUBSTITUÍDO.',
  leisCitadas: [],
};

/**
 * Repo fake que registra o texto persistido e separa o que está
 * GRAVADO vs. o que está no `oficioGerado` (JSON). `registrarOficioExportado`
 * espelha o Prisma real: grava `oficioExportado`+`oficioExportadoEm`.
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
      // espelha o estado persistido p/ asserção
      (this as { persistidoOficio: string | null }).persistidoOficio =
        texto;
      return atual;
    },
  };
}

/** Engine fake: devolve %PDF e registra o HTML recebido. */
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
  it('oficio: PERSISTE o texto editado e renderiza A PARTIR do persistido (NÃO do JSON) — §9', async () => {
    const repo = fakeRepo(registroBase());
    const eng = fakeEngine();
    const POST = criarExportPOST({ analysisRepo: repo, pdfEngine: eng });

    const TEXTO_EDITADO =
      '# Ofício EDITADO pela Stefany\n\n' +
      'Solicita-se esclarecimento sobre a vigência da norma.';

    const res = await POST(
      req({ tipo: 'oficio', textoOficio: TEXTO_EDITADO }),
      ctx()
    );

    expect(res.status).toBe(200);
    // (1) o texto editado foi PERSISTIDO via repo (oficioExportado).
    expect(repo.persistidoOficio).toBe(TEXTO_EDITADO);
    // (2) o PDF foi renderizado A PARTIR do texto persistido/editado...
    const html = eng.htmlVisto[0];
    expect(html).toContain('<h1>Ofício EDITADO pela Stefany</h1>');
    expect(html).toContain(
      '<p>Solicita-se esclarecimento sobre a vigência da norma.</p>'
    );
    // ...e NÃO regenerou do JSON original (oficioGerado.markdown).
    expect(html).not.toContain('Ofício GERADO pelo robô');
    expect(html).not.toContain('Texto automático que será SUBSTITUÍDO');
  });

  it('oficio: persiste ANTES de renderizar (ordem §9 — sem perda de sinal)', async () => {
    // Engine que falha: mesmo assim o texto editado deve ter sido
    // persistido (a persistência é o sinal-ouro §11b, não pode depender
    // do sucesso da render do PDF derivado).
    const repo = fakeRepo(registroBase());
    const POST = criarExportPOST({
      analysisRepo: repo,
      pdfEngine: {
        async htmlParaPdf() {
          throw new Error('chromium indisponível');
        },
      },
    });
    await expect(
      POST(req({ tipo: 'oficio', textoOficio: 'texto final' }), ctx())
    ).rejects.toThrow(/chromium/);
    expect(repo.persistidoOficio).toBe('texto final');
  });

  it('relatorio: projeta do JSON da extração (sem escrever no repo)', async () => {
    const repo = fakeRepo(registroBase());
    const eng = fakeEngine();
    const POST = criarExportPOST({ analysisRepo: repo, pdfEngine: eng });

    const res = await POST(req({ tipo: 'relatorio' }), ctx());

    expect(res.status).toBe(200);
    expect(eng.htmlVisto[0]).toContain('Principais pontos');
    expect(eng.htmlVisto[0]).toContain('Serviços funerários — Niterói');
    // Relatório NÃO persiste nada (projeção pura, regenerável).
    expect(repo.persistidoOficio).toBeNull();
  });

  it('Content-Type application/pdf + Content-Disposition attachment', async () => {
    const repo = fakeRepo(registroBase());
    const POST = criarExportPOST({
      analysisRepo: repo,
      pdfEngine: fakeEngine(),
    });
    const res = await POST(req({ tipo: 'relatorio' }), ctx());
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toMatch(/^attachment;/);
    expect(cd).toContain('.pdf');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('job inexistente / sem análise → 404', async () => {
    const repo = fakeRepo(null);
    const POST = criarExportPOST({
      analysisRepo: repo,
      pdfEngine: fakeEngine(),
    });
    const res = await POST(req({ tipo: 'relatorio' }), ctx('nao-existe'));
    expect(res.status).toBe(404);
  });

  it('tipo inválido → 400', async () => {
    const repo = fakeRepo(registroBase());
    const POST = criarExportPOST({
      analysisRepo: repo,
      pdfEngine: fakeEngine(),
    });
    const res = await POST(req({ tipo: 'planilha' }), ctx());
    expect(res.status).toBe(400);
  });

  it('oficio sem textoOficio → 400 (nada a persistir)', async () => {
    const repo = fakeRepo(registroBase());
    const POST = criarExportPOST({
      analysisRepo: repo,
      pdfEngine: fakeEngine(),
    });
    const res = await POST(req({ tipo: 'oficio' }), ctx());
    expect(res.status).toBe(400);
    expect(repo.persistidoOficio).toBeNull();
  });
});
