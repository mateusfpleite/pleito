import { describe, it, expect } from 'vitest';
import {
  escaparHtml,
  markdownParaHtmlSeguro,
  montarHtmlRelatorio,
  montarHtmlOficio,
  renderRelatorioPdf,
  renderOficioPdf,
  type PdfEngine,
} from './render.ts';
import { EditalExtractionSchema } from '../../domain/schema.ts';
import type { EditalExtraction } from '../../domain/schema.ts';

/**
 * DETERMINISTIC tests of the PDF render. They do NOT test the chromium
 * binary (runtime RESIDUE — it only exists in the worker container;
 * validated in deploy/E2E, @superpowers:testing-anti-patterns). Here we
 * prove WHAT IS OURS: (1) the assembled HTML contains the right fields,
 * (2) the anti-XSS escaping in the markdown→HTML conversion, (3) the
 * Buffer contract via a deterministic FAKE engine.
 */

/** Fake engine: returns a deterministic `%PDF` Buffer and records the
 * HTML it received (to assert the assembly). It renders nothing real. */
function fakeEngine(): PdfEngine & { htmlVisto: string[] } {
  const htmlVisto: string[] = [];
  return {
    htmlVisto,
    async htmlParaPdf(html: string): Promise<Buffer> {
      htmlVisto.push(html);
      // Deterministic Buffer that STARTS with the PDF signature.
      return Buffer.from(`%PDF-1.4 fake(${html.length})`);
    },
  };
}

function extracao(
  overrides: Partial<EditalExtraction> = {}
): EditalExtraction {
  return EditalExtractionSchema.parse({
    municipio: 'Jaborandi',
    uf: 'BA',
    ente: {
      tipo: 'prefeitura',
      razaoSocial: 'Prefeitura Municipal de Jaborandi',
      cnpj: null,
    },
    modalidade: 'pregao-eletronico',
    numero: '7/2026',
    processoAdministrativo: null,
    dataPublicacao: null,
    dataSessao: null,
    uasg: null,
    regimeJuridico: 'lei-14133',
    objetoCorpo: 'Serviços funerários completos',
    objetoCapa: null,
    objetoSummary: 'Serviços funerários completos para o município',
    tipoObjeto: ['servicos-funerarios-completos'],
    secretariaDemandante: null,
    valor: { estimado: 123456.78, sigiloso: false, procedencia: 'capa' },
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
    itensLicitados: [
      {
        numero: '1',
        descricao: 'Urna mortuária adulto',
        tipo: 'urna',
        publicoAlvo: 'adulto',
        unidade: 'un',
        quantidade: 50,
        valorUnitarioReferencial: 800,
      },
    ],
    leisReferenciadas: [
      {
        descricao: 'Lei nº 8.666/93',
        escopo: 'federal',
        tipoNorma: 'lei',
        numero: '8666',
        ano: 1993,
        contextoNoEdital: 'Citada no preâmbulo',
        revogada: true,
        statusVerificado: 'revogada',
        fonteVerificacao: 'baseline',
      },
    ],
    anexos: [],
    incoerencias: [
      {
        tipo: 'lei-revogada',
        descricao: 'Edital cita Lei 8.666/93 sob regime da 14.133',
        severidade: 'alta',
      },
    ],
    trechosAmbiguos: [],
    plataforma: 'LICITANET',
    subcontratacaoPermitida: false,
    intervaloMinimoLances: 100,
    prazoRecursosDiasUteis: 3,
    informacoesViabilidade: 'Demanda assistencial',
    pontosDeAtencao: [
      {
        descricao: 'Valor sigiloso impede análise de margem',
        categoria: 'financeiro',
        severidade: 'media',
        recomendaManifestacao: false,
      },
    ],
    fonte: { pdfNativo: false, ocr: false, paginas: 5, url: null },
    ...overrides,
  });
}

describe('escaparHtml (anti-XSS)', () => {
  it('neutralizes the 5 HTML/attribute metacharacters', () => {
    expect(escaparHtml(`<script>"x" & 'y'`)).toBe(
      '&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;'
    );
  });

  it('escapes & before entities (no double-escaping)', () => {
    expect(escaparHtml('a & <b>')).toBe('a &amp; &lt;b&gt;');
  });
});

describe('markdownParaHtmlSeguro (minimal and safe conversion)', () => {
  it('does NOT let user markup pass through (XSS blocked)', () => {
    const malicioso =
      '# Título <script>alert(1)</script>\n\n' +
      'Parágrafo com <img src=x onerror=alert(2)>\n\n' +
      '- item <b onclick="evil()">';
    const html = markdownParaHtmlSeguro(malicioso);
    // Security invariant: no TAG injected by the user. The content's
    // `<`/`>` becomes an entity — `onerror=`/`onclick=` survive only as
    // inert TEXT inside `&lt;...&gt;` (no real tag, they do not execute).
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b onclick');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
    expect(html).toContain(
      'item &lt;b onclick=&quot;evil()&quot;&gt;'
    );
    // Legitimate structure (generated by US) preserved.
    expect(html).toContain('<h1>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>');
    expect(html).toContain('<p>');
  });

  it('headings, paragraphs and lists become structural HTML', () => {
    const html = markdownParaHtmlSeguro(
      '## Pedido\n\nPrezados,\n\n- ponto A\n- ponto B'
    );
    expect(html).toContain('<h2>Pedido</h2>');
    expect(html).toContain('<p>Prezados,</p>');
    expect(html).toContain('<li>ponto A</li>');
    expect(html).toContain('<li>ponto B</li>');
  });
});

describe('montarHtmlRelatorio (JSON projection — "Principais pontos" format)', () => {
  it('contains the extraction fields (summary, laws, points of attention)', () => {
    const html = montarHtmlRelatorio(extracao());
    expect(html).toContain('Principais pontos');
    expect(html).toContain('Jaborandi');
    expect(html).toContain('Serviços funerários completos para o município');
    expect(html).toContain('Lei nº 8.666/93');
    expect(html).toContain('✗ Revogada');
    expect(html).toContain('Urna mortuária adulto');
    expect(html).toContain('Valor sigiloso impede análise de margem');
    expect(html).toContain(
      'Edital cita Lei 8.666/93 sob regime da 14.133'
    );
  });

  it('escapes edital data (third-party PDF field does not inject markup)', () => {
    const html = montarHtmlRelatorio(
      extracao({
        objetoSummary: 'Objeto <script>alert(1)</script> malicioso',
      })
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('montarHtmlOficio (from the TEXT, not the JSON)', () => {
  it('contains the ofício text converted and escaped', () => {
    const texto =
      '# Ofício de esclarecimento\n\n' +
      'Solicita-se confirmação sobre <vigência>.';
    const html = montarHtmlOficio(texto);
    expect(html).toContain('<h1>Ofício de esclarecimento</h1>');
    expect(html).toContain(
      'Solicita-se confirmação sobre &lt;vigência&gt;.'
    );
    expect(html).not.toContain('<vigência>');
  });
});

describe('renderRelatorioPdf / renderOficioPdf (contrato Buffer via engine fake)', () => {
  it('renderRelatorioPdf returns a Buffer starting with %PDF', async () => {
    const eng = fakeEngine();
    const buf = await renderRelatorioPdf(extracao(), eng);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    // The engine received the relatório HTML (projection of the JSON).
    expect(eng.htmlVisto[0]).toContain('Principais pontos');
    expect(eng.htmlVisto[0]).toContain('Jaborandi');
  });

  it('renderOficioPdf renders FROM the received text (not the JSON)', async () => {
    const eng = fakeEngine();
    const buf = await renderOficioPdf(
      '# Ofício editado pela Stefany\n\nTexto final.',
      eng
    );
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    expect(eng.htmlVisto[0]).toContain(
      '<h1>Ofício editado pela Stefany</h1>'
    );
    expect(eng.htmlVisto[0]).toContain('<p>Texto final.</p>');
  });
});
