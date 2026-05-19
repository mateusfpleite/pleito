/**
 * Geração de PDF on-demand (SPEC §8/§9) — relatório da análise e ofício.
 *
 * PRINCÍPIO §9 (crítico): o PDF é uma PROJEÇÃO DERIVADA — nunca
 * persistido. O relatório é projeção do JSON da extração (pode regenerar
 * sempre). O ofício exportado usa o TEXTO EDITADO pela Stefany,
 * persistido em `Analysis.oficioExportado` no ato do export — este módulo
 * recebe esse texto já persistido e o renderiza; NÃO regenera do JSON.
 *
 * ENGINE INJETÁVEL: a render real roda via chromium headless do worker
 * container (Dockerfile instala `chromium` — path padrão do pacote Debian
 * em `node:20-slim`: `/usr/bin/chromium`). chromium NÃO está disponível
 * no ambiente de DEV (só no container) — é RESÍDUO de runtime. Por isso a
 * lógica (montagem do HTML, escape anti-XSS, contrato do Buffer) é testada
 * com um `PdfEngine` FAKE; a render real (chromium) valida em deploy/E2E,
 * nunca em unit (@superpowers:testing-anti-patterns).
 */
import type { EditalExtraction } from '../../domain/schema.ts';

/**
 * Port do motor de PDF: HTML → bytes de PDF. Em produção,
 * `chromiumPdfEngine` (playwright-core apontando pro chromium do
 * container). Em teste, um fake determinístico que devolve `%PDF...`.
 */
export interface PdfEngine {
  /** Renderiza um documento HTML completo em bytes de PDF. */
  htmlParaPdf(html: string): Promise<Buffer>;
}

/* ------------------------------------------------------------------ */
/* Escape anti-XSS (markdown→HTML / dados→HTML)                         */
/* ------------------------------------------------------------------ */

/**
 * Escapa TODO conteúdo dinâmico antes de interpolar no HTML. O ofício
 * vem de texto livre editado pela Stefany e o relatório de campos
 * extraídos de PDFs de terceiros: nada disso pode injetar markup.
 * `&` primeiro (senão re-escaparia as próprias entidades).
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
 * Conversão MÍNIMA e SEGURA de markdown→HTML para o ofício. Não usa lib
 * pesada: o ofício do Drafter é prosa simples (títulos `#`, parágrafos,
 * listas `-`). REGRA DE SEGURANÇA: o texto é integralmente ESCAPADO
 * ANTES de qualquer reconhecimento de estrutura — markup do usuário
 * (`<script>`, `<img onerror>`, etc.) nunca atravessa para o HTML final.
 * Só geramos as tags nós mesmos, a partir de prefixos de linha já
 * neutralizados.
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
    // ESCAPA SEMPRE, antes de olhar estrutura: nenhum markup do usuário
    // sobrevive. O reconhecimento abaixo opera sobre texto já seguro.
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
/* Templates HTML                                                      */
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
 * relatório HTML in the "Main points" format (SPEC §8): an organized summary
 * + cited laws with status + pontos de atenção/inconsistencies/ambiguous
 * excerpts highlighted by severity. PURE PROJECTION of the JSON
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
 * HTML do ofício. Recebe o TEXTO (markdown) já EXPORTADO/PERSISTIDO —
 * jamais o JSON. Converte o markdown→HTML de forma mínima e SEGURA
 * (escape anti-XSS antes de qualquer estrutura).
 */
export function montarHtmlOficio(textoOficioMarkdown: string): string {
  return `<!doctype html><html lang="pt-BR"><head>
    <meta charset="utf-8">${ESTILO_BASE}</head><body>
    <article>${markdownParaHtmlSeguro(textoOficioMarkdown)}</article>
  </body></html>`;
}

/* ------------------------------------------------------------------ */
/* Funções de render (puras quanto à lógica; engine injetado)          */
/* ------------------------------------------------------------------ */

/** Relatório: projeção do JSON da extração → PDF. Regenerável sempre. */
export function renderRelatorioPdf(
  extracao: EditalExtraction,
  engine: PdfEngine
): Promise<Buffer> {
  return engine.htmlParaPdf(montarHtmlRelatorio(extracao));
}

/**
 * Ofício: renderiza o PDF A PARTIR do texto editado JÁ PERSISTIDO (§9).
 * Quem persiste é o handler de export (via AnalysisRepo) ANTES de chamar
 * aqui — esta função NÃO conhece o JSON do ofício original.
 */
export function renderOficioPdf(
  textoOficioMarkdown: string,
  engine: PdfEngine
): Promise<Buffer> {
  return engine.htmlParaPdf(montarHtmlOficio(textoOficioMarkdown));
}

/**
 * Engine de produção: chromium headless do worker container via
 * `playwright-core`. RESÍDUO de runtime — chromium só existe no
 * container (Dockerfile: `apt-get install -y chromium`; path padrão do
 * pacote Debian em `node:20-slim`: `/usr/bin/chromium`, sobrescrevível
 * por `CHROMIUM_PATH`). `playwright-core` é dependência OPCIONAL resolvida
 * preguiçosamente: nunca é importado fora do container (e os testes usam
 * engine fake), então sua ausência no DEV não quebra nada.
 */
/**
 * Superfície MÍNIMA do playwright-core que usamos. Tipada localmente de
 * propósito: `playwright-core` é `optionalDependencies` (só instalada no
 * container) — não amarrar o typecheck do DEV a um pacote ausente. O
 * import é dinâmico e nunca executa fora do worker (RESÍDUO de runtime).
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
      // Import dinâmico: só resolvido no container (RESÍDUO documentado).
      // `import(variável)` evita a resolução estática do TS p/ um pacote
      // que não está no DEV (optionalDependencies).
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
