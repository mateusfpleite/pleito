/**
 * Lógica testável de POST /api/export/:jobId (fora do `route.ts` — Next.js
 * só aceita exports de método/config em `route.ts`).
 *
 * SPEC §8/§9 — export PDF ON-DEMAND. O PDF é projeção derivada, NUNCA
 * persistido. Dois tipos:
 *
 *  - `relatorio`: projeção do JSON da extração persistida (regenerável
 *    sempre). Sem efeito colateral de escrita.
 *
 *  - `oficio`: o PDF usa o TEXTO EDITADO pela Stefany (a textarea da
 *    Phase 13), enviado no body. O ato de exportar (1) PERSISTE esse
 *    texto em `Analysis.oficioExportado`+`oficioExportadoEm` via repo,
 *    (2) renderiza o PDF A PARTIR do texto AGORA persistido — jamais
 *    regenera do `oficioGerado` (JSON/markdown original). O diff
 *    gerado×exportado é sinal-ouro de eval (§11b).
 *
 * `id` é o JOB id (a UI nunca conhece o id da Analysis). Job inexistente
 * ou sem análise → 404.
 */
import type {
  AnalysisRepo,
  TelemetryPort,
} from '../../../../domain/ports.ts';
import {
  renderRelatorioPdf,
  renderOficioPdf,
  type PdfEngine,
} from '../../../../adapters/pdf/render.ts';
import {
  registrarSeguro,
  calcularDiffOficio,
  payloadOficioDiff,
  EVENTO,
} from '../../../../application/telemetria.ts';

export type ExportPostDeps = {
  analysisRepo: AnalysisRepo;
  pdfEngine: PdfEngine;
  /** Telemetria NÃO-bloqueante (§11b). Falha aqui nunca derruba o export. */
  telemetry: TelemetryPort;
};

export type ExportCtx = { params: Promise<{ id: string }> };

type ExportBody = {
  tipo?: unknown;
  textoOficio?: unknown;
};

function nomeArquivo(tipo: 'relatorio' | 'oficio', jobId: string): string {
  const slug = jobId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'job';
  return `${tipo}-${slug}.pdf`;
}

function respostaPdf(
  buffer: Buffer,
  tipo: 'relatorio' | 'oficio',
  jobId: string
): Response {
  // Buffer → ArrayBuffer exato (evita expor o pool subjacente).
  const body = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
  return new Response(body as ArrayBuffer, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${nomeArquivo(
        tipo,
        jobId
      )}"`,
    },
  });
}

/** Fábrica testável do handler de export (deps injetadas). */
export function criarExportPOST(deps: ExportPostDeps) {
  return async function POST(
    req: Request,
    ctx: ExportCtx
  ): Promise<Response> {
    const { id: jobId } = await ctx.params;

    let body: ExportBody;
    try {
      body = (await req.json()) as ExportBody;
    } catch {
      return Response.json(
        { erro: 'body inválido: JSON esperado' },
        { status: 400 }
      );
    }

    const tipo = body.tipo;
    if (tipo !== 'relatorio' && tipo !== 'oficio') {
      return Response.json(
        { erro: "tipo inválido: use 'relatorio' ou 'oficio'" },
        { status: 400 }
      );
    }

    const analise = await deps.analysisRepo.buscarPorJobId(jobId);
    if (!analise) {
      return Response.json(
        { erro: `análise do job ${jobId} não encontrada` },
        { status: 404 }
      );
    }

    if (tipo === 'relatorio') {
      // Projeção PURA do JSON persistido — regenerável, sem escrita.
      const pdf = await renderRelatorioPdf(
        analise.extracao,
        deps.pdfEngine
      );
      // Evento implícito de uso (§11b) — não-bloqueante.
      await registrarSeguro(deps.telemetry, analise.id, EVENTO.export, {
        tipo: 'relatorio',
      });
      return respostaPdf(pdf, 'relatorio', jobId);
    }

    // tipo === 'oficio': §9 — persistir o texto editado ANTES de render.
    const textoOficio = body.textoOficio;
    if (typeof textoOficio !== 'string' || textoOficio.trim() === '') {
      return Response.json(
        {
          erro:
            'textoOficio obrigatório (texto editado a exportar) p/ tipo=oficio',
        },
        { status: 400 }
      );
    }

    // (1) PERSISTE o texto editado; (2) renderiza a partir do PERSISTIDO.
    // Nunca regenera do `analise.oficioGerado` (JSON original).
    const atualizado = await deps.analysisRepo.registrarOficioExportado(
      analise.id,
      textoOficio
    );
    const pdf = await renderOficioPdf(
      atualizado.oficioExportado as string,
      deps.pdfEngine
    );

    // SINAL-OURO (§11b): diff ofício gerado × exportado. O `oficioGerado`
    // (markdown original do Drafter) é PRESERVADO no registro — o delta
    // vs o texto exportado é rótulo direto e não-supervisionado de
    // erro/lacuna do Drafter. FALLBACK DE SINAL VAZIO: se ela exportou
    // sem editar (diff vazio) OU não há ofício gerado, o sinal-ouro é
    // NULO; o payload já carrega `exportou:true` como sinal de RESERVA
    // (export-sim + o 👍/👎 cobre o resto). Toda telemetria aqui é
    // não-bloqueante (registrarSeguro) — nunca derruba o export.
    const markdownGerado = analise.oficioGerado?.markdown ?? null;
    if (markdownGerado !== null) {
      const diff = calcularDiffOficio(markdownGerado, textoOficio);
      await registrarSeguro(
        deps.telemetry,
        analise.id,
        EVENTO.oficioDiff,
        payloadOficioDiff(diff, true)
      );
      if (diff.foiEditado) {
        await registrarSeguro(
          deps.telemetry,
          analise.id,
          EVENTO.oficioEditado,
          {
            distanciaCaracteres: diff.distanciaCaracteres,
            linhasAdicionadas: diff.linhasAdicionadas,
            linhasRemovidas: diff.linhasRemovidas,
          }
        );
      }
    }
    await registrarSeguro(deps.telemetry, analise.id, EVENTO.export, {
      tipo: 'oficio',
      // RESERVA explícito: export-sim + houve edição? (§11b).
      foiEditado:
        markdownGerado !== null && markdownGerado !== textoOficio,
    });
    return respostaPdf(pdf, 'oficio', jobId);
  };
}
