/**
 * On-demand PDF generation (SPEC §8/§9) — analysis relatório and ofício.
 *
 * §9 PRINCIPLE (critical): the PDF is a DERIVED PROJECTION — never
 * persisted. The relatório is a projection of the extraction JSON (can
 * always regenerate). The exported ofício uses the TEXT EDITED by Stefany,
 * persisted in `Analysis.oficioExportado` at export time — this module
 * receives that already-persisted text and renders it; it does NOT
 * regenerate from the JSON.
 *
 * INJECTABLE ENGINE: the real render runs via headless chromium in the
 * worker container (the Dockerfile installs `chromium` — default path of
 * the Debian package on `node:20-slim`: `/usr/bin/chromium`). chromium is
 * NOT available in the DEV environment (only in the container) — it is a
 * runtime RESIDUE. Hence the logic (HTML assembly, anti-XSS escaping,
 * Buffer contract) is tested with a FAKE `PdfEngine`; the real render
 * (chromium) is validated in deploy/E2E, never in unit
 * (@superpowers:testing-anti-patterns).
 */
import type { EditalExtraction } from '../../domain/schema.ts';

/**
 * PDF engine port: HTML → PDF bytes. In production,
 * `chromiumPdfEngine` (playwright-core pointing at the container's
 * chromium). In tests, a deterministic fake that returns `%PDF...`.
 */
export interface PdfEngine {
  /** Renders a complete HTML document into PDF bytes. */
  htmlParaPdf(html: string): Promise<Buffer>;
}

/* ------------------------------------------------------------------ */
/* Anti-XSS escaping (markdown→HTML / data→HTML)                       */
/* ------------------------------------------------------------------ */

/**
 * Escapes ALL dynamic content before interpolating into HTML. The ofício
 * comes from free text edited by Stefany and the relatório from fields
 * extracted from third-party PDFs: none of it may inject markup. `&`
 * first (otherwise it would re-escape its own entities).
 */
export function escaparHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * MINIMAL and SAFE markdown→HTML conversion for the ofício. Does not use
 * a heavy lib: the Drafter's ofício is simple prose (`#` headings,
 * paragraphs, `-` lists). SECURITY RULE: the text is fully ESCAPED
 * BEFORE any structure recognition — user markup (`<script>`,
 * `<img onerror>`, etc.) never reaches the final HTML. We only generate
 * the tags ourselves, from already-neutralized line prefixes.
 */
export function markdownParaHtmlSeguro(md: string): string {
  const linhas = md.replace(/\r\n/g, '\n').split('\n');
  const blocos: string[] = [];
  let listaAberta = false;

  const fecharLista = () => {
    if (listaAberta) {
      blocos.push('</ul>');
      listaAberta = false;
    }
  };

  for (const linhaCrua of linhas) {
    const linha = linhaCrua.trimEnd();
    // ALWAYS escape, before looking at structure: no user markup
    // survives. The recognition below operates on already-safe text.
    const tituloMatch = /^(#{1,6})\s+(.*)$/.exec(linha);
    if (tituloMatch) {
      fecharLista();
      const nivel = Math.min(tituloMatch[1].length, 6);
      blocos.push(`<h${nivel}>${escaparHtml(tituloMatch[2])}</h${nivel}>`);
      continue;
    }
    const itemMatch = /^[-*]\s+(.*)$/.exec(linha);
    if (itemMatch) {
      if (!listaAberta) {
        blocos.push('<ul>');
        listaAberta = true;
      }
      blocos.push(`<li>${escaparHtml(itemMatch[1])}</li>`);
      continue;
    }
    if (linha.trim() === '') {
      fecharLista();
      continue;
    }
    fecharLista();
    blocos.push(`<p>${escaparHtml(linha)}</p>`);
  }
  fecharLista();
  return blocos.join('\n');
}

/* ------------------------------------------------------------------ */
/* HTML templates                                                      */
/* ------------------------------------------------------------------ */

const ESTILO_BASE = `
  <style>
    body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a;
      font-size: 12px; line-height: 1.5; margin: 32px; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    h2 { font-size: 14px; margin: 20px 0 6px; border-bottom: 1px solid #ccc;
      padding-bottom: 2px; }
    h3 { font-size: 12px; margin: 12px 0 4px; }
    table { width: 100%; border-collapse: collapse; margin: 6px 0; }
    th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #ddd;
      font-size: 11px; vertical-align: top; }
    .meta { color: #555; font-size: 11px; }
    .destaque-alta { border-left: 4px solid #a31515; padding-left: 8px; }
    .destaque-media { border-left: 4px solid #8a5a00; padding-left: 8px; }
    .destaque-baixa { border-left: 4px solid #888; padding-left: 8px; }
    ul { margin: 4px 0; padding-left: 20px; }
    .vazio { color: #999; font-style: italic; }
    .badge { font-weight: bold; }
  </style>`;

const SEV_CLASSE: Record<string, string> = {
  alta: 'destaque-alta',
  media: 'destaque-media',
  baixa: 'destaque-baixa',
};

const STATUS_ROTULO: Record<string, string> = {
  vigente: '✓ Vigente',
  revogada: '✗ Revogada',
  contestada: '⚠ Contestada',
  inexistente: '⚠ Inexistente',
  'nao-verificado': '⚠ Não-verificado',
};

function fmtMoedaBRL(v: number | null): string {
  if (v == null) return '—';
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(v);
}

/**
 * relatório HTML in the "Main points" format (SPEC §8): an organized
 * summary + cited laws with status + attention points/inconsistencies/
 * ambiguous excerpts highlighted by severity. PURE PROJECTION of the JSON
 * (regenerable). All dynamic data is escaped (anti-XSS: fields come from
 * third-party PDFs).
 */
export function montarHtmlRelatorio(e: EditalExtraction): string {
  const esc = escaparHtml;
  const linhasLeis = e.leisReferenciadas
    .map(
      (l) => `<tr>
        <td>${esc(l.descricao)}</td>
        <td>${esc(l.tipoNorma)} · ${esc(l.escopo)}</td>
        <td>${esc(l.contextoNoEdital)}</td>
        <td class="badge">${esc(
          STATUS_ROTULO[l.statusVerificado] ?? l.statusVerificado
        )}</td>
      </tr>`
    )
    .join('');

  const blocoSeveridade = (
    titulo: string,
    itens: { descricao: string; severidade: string; extra?: string }[]
  ) => {
    if (itens.length === 0) {
      return `<h2>${esc(titulo)}</h2><p class="vazio">Nenhum registro.</p>`;
    }
    const corpo = itens
      .map(
        (i) => `<div class="${SEV_CLASSE[i.severidade] ?? ''}"
          style="margin:6px 0;">
          <strong>[${esc(i.severidade)}]</strong> ${esc(i.descricao)}
          ${i.extra ? `<div class="meta">${esc(i.extra)}</div>` : ''}
        </div>`
      )
      .join('');
    return `<h2>${esc(titulo)} (${itens.length})</h2>${corpo}`;
  };

  return `<!doctype html><html lang="pt-BR"><head>
    <meta charset="utf-8">${ESTILO_BASE}</head><body>
    <h1>Principais pontos — análise do edital</h1>
    <p class="meta">${esc(e.municipio)}/${esc(e.uf)} ·
      ${esc(e.ente.razaoSocial)} · ${esc(e.modalidade)} nº
      ${esc(e.numero)} · regime ${esc(e.regimeJuridico)}</p>

    <h2>Resumo</h2>
    <table>
      <tr><th>Objeto</th><td>${esc(e.objetoSummary)}</td></tr>
      <tr><th>Valor estimado</th><td>${
        e.valor.sigiloso ? 'SIGILOSO' : esc(fmtMoedaBRL(e.valor.estimado))
      }</td></tr>
      <tr><th>Critério / agrupamento</th><td>${esc(
        e.criterioJulgamento
      )} · ${esc(e.agrupamento)}</td></tr>
      <tr><th>Vigência do contrato (meses)</th><td>${esc(
        String(e.vigenciaContrato.meses ?? '—')
      )}</td></tr>
      <tr><th>Prazo de recursos (dias úteis)</th><td>${esc(
        String(e.prazoRecursosDiasUteis ?? '—')
      )}</td></tr>
      <tr><th>Plataforma</th><td>${esc(e.plataforma ?? '—')}</td></tr>
    </table>

    <h2>Itens licitados (${e.itensLicitados.length})</h2>
    ${
      e.itensLicitados.length === 0
        ? '<p class="vazio">Nenhum item itemizado.</p>'
        : `<table><tr><th>Nº</th><th>Descrição</th><th>Tipo</th>
            <th>Qtd</th><th>Valor unit. ref.</th></tr>
            ${e.itensLicitados
              .map(
                (it) => `<tr><td>${esc(it.numero)}</td>
                  <td>${esc(it.descricao)}</td><td>${esc(it.tipo)}</td>
                  <td>${esc(String(it.quantidade))} ${esc(
                    it.unidade
                  )}</td>
                  <td>${esc(
                    fmtMoedaBRL(it.valorUnitarioReferencial)
                  )}</td></tr>`
              )
              .join('')}</table>`
    }

    <h2>Leis citadas (${e.leisReferenciadas.length})</h2>
    ${
      e.leisReferenciadas.length === 0
        ? '<p class="vazio">Nenhuma norma referenciada.</p>'
        : `<table><tr><th>Norma</th><th>Tipo/escopo</th>
            <th>Contexto</th><th>Status verificado</th></tr>
            ${linhasLeis}</table>`
    }

    ${blocoSeveridade(
      'Pontos de atenção',
      e.pontosDeAtencao.map((p) => ({
        descricao: p.descricao,
        severidade: p.severidade,
        extra: `${p.categoria}${
          p.recomendaManifestacao ? ' · recomenda manifestação' : ''
        }`,
      }))
    )}
    ${blocoSeveridade(
      'Inconsistências',
      e.incoerencias.map((i) => ({
        descricao: i.descricao,
        severidade: i.severidade,
        extra: i.tipo,
      }))
    )}
    ${
      e.trechosAmbiguos.length === 0
        ? '<h2>Trechos ambíguos</h2><p class="vazio">Nenhum.</p>'
        : `<h2>Trechos ambíguos (${e.trechosAmbiguos.length})</h2>${e.trechosAmbiguos
            .map(
              (t) => `<div style="margin:6px 0;">
              <em>“${esc(t.trechoLiteral)}”</em>
              <div class="meta">Brecha: ${esc(
                t.porQueAmbiguo
              )} — Seção: ${esc(t.secaoOndeAparece)}</div></div>`
            )
            .join('')}`
    }
  </body></html>`;
}

/**
 * Ofício HTML. Receives the TEXT (markdown) already EXPORTED/PERSISTED —
 * never the JSON. Converts the markdown→HTML in a MINIMAL and SAFE way
 * (anti-XSS escaping before any structure).
 */
export function montarHtmlOficio(textoOficioMarkdown: string): string {
  return `<!doctype html><html lang="pt-BR"><head>
    <meta charset="utf-8">${ESTILO_BASE}</head><body>
    <article>${markdownParaHtmlSeguro(textoOficioMarkdown)}</article>
  </body></html>`;
}

/* ------------------------------------------------------------------ */
/* Render functions (pure as to logic; engine injected)                */
/* ------------------------------------------------------------------ */

/** Relatório: projection of the extraction JSON → PDF. Always regenerable. */
export function renderRelatorioPdf(
  extracao: EditalExtraction,
  engine: PdfEngine
): Promise<Buffer> {
  return engine.htmlParaPdf(montarHtmlRelatorio(extracao));
}

/**
 * Ofício: renders the PDF FROM the edited text ALREADY PERSISTED (§9).
 * The export handler is what persists it (via AnalysisRepo) BEFORE
 * calling here — this function does NOT know the original ofício JSON.
 */
export function renderOficioPdf(
  textoOficioMarkdown: string,
  engine: PdfEngine
): Promise<Buffer> {
  return engine.htmlParaPdf(montarHtmlOficio(textoOficioMarkdown));
}

/**
 * Production engine: headless chromium from the worker container via
 * `playwright-core`. Runtime RESIDUE — chromium only exists in the
 * container (Dockerfile: `apt-get install -y chromium`; default path of
 * the Debian package on `node:20-slim`: `/usr/bin/chromium`, overridable
 * via `CHROMIUM_PATH`). `playwright-core` is an OPTIONAL dependency
 * resolved lazily: it is never imported outside the container (and tests
 * use the fake engine), so its absence in DEV breaks nothing.
 */
/**
 * MINIMAL surface of playwright-core that we use. Typed locally on
 * purpose: `playwright-core` is `optionalDependencies` (only installed in
 * the container) — do not tie the DEV typecheck to an absent package. The
 * import is dynamic and never runs outside the worker (runtime RESIDUE).
 */
type PlaywrightChromiumLike = {
  chromium: {
    launch(opts: {
      executablePath: string;
      args: string[];
    }): Promise<{
      newPage(): Promise<{
        setContent(
          html: string,
          opts: { waitUntil: 'load' }
        ): Promise<void>;
        pdf(opts: {
          format: string;
          printBackground: boolean;
          margin: {
            top: string;
            bottom: string;
            left: string;
            right: string;
          };
        }): Promise<Uint8Array>;
      }>;
      close(): Promise<void>;
    }>;
  };
};

export function chromiumPdfEngine(): PdfEngine {
  const executablePath = process.env.CHROMIUM_PATH ?? '/usr/bin/chromium';
  return {
    async htmlParaPdf(html: string): Promise<Buffer> {
      // Dynamic import: only resolved in the container (documented
      // RESIDUE). `import(variable)` avoids TS static resolution for a
      // package not present in DEV (optionalDependencies).
      const mod = 'playwright-core';
      const { chromium } = (await import(
        /* @vite-ignore */ mod
      )) as PlaywrightChromiumLike;
      const browser = await chromium.launch({
        executablePath,
        args: ['--no-sandbox'],
      });
      try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'load' });
        const pdf = await page.pdf({
          format: 'A4',
          printBackground: true,
          margin: { top: '0', bottom: '0', left: '0', right: '0' },
        });
        return Buffer.from(pdf);
      } finally {
        await browser.close();
      }
    },
  };
}
