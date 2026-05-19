/**
 * Lógica testável de POST /api/feedback/:jobId — feedback explícito
 * MÍNIMO (SPEC §11b: 👍/👎 + texto opcional por análise). Fricção baixa:
 * 1 booleano + texto opcional.
 *
 * `jobId` é o id do JOB (a UI nunca conhece o id da Analysis). Resolve a
 * análise via `buscarPorJobId` e grava telemetria `feedback`. A gravação
 * é NÃO-bloqueante (`registrarSeguro`): mesmo se a telemetria falhar, o
 * endpoint responde 202 (o feedback é sinal de RESERVA — não pode, ele
 * próprio, virar um 5xx que frustra a usuária). Análise inexistente → 404.
 *
 * Body: `{ util: boolean, texto?: string }`. `util` ausente/!=boolean →
 * 400 (o sinal mínimo é o booleano; sem ele não há o que registrar).
 */
import type {
  AnalysisRepo,
  TelemetryPort,
} from '../../../../domain/ports.ts';
import { registrarSeguro, EVENTO } from '../../../../application/telemetria.ts';

export type FeedbackPostDeps = {
  analysisRepo: AnalysisRepo;
  telemetry: TelemetryPort;
};

export type FeedbackCtx = { params: Promise<{ jobId: string }> };

type FeedbackBody = { util?: unknown; texto?: unknown };

export function criarFeedbackPOST(deps: FeedbackPostDeps) {
  return async function POST(
    req: Request,
    ctx: FeedbackCtx
  ): Promise<Response> {
    const { jobId } = await ctx.params;

    let body: FeedbackBody;
    try {
      body = (await req.json()) as FeedbackBody;
    } catch {
      return Response.json(
        { erro: 'body inválido: JSON esperado' },
        { status: 400 }
      );
    }

    if (typeof body.util !== 'boolean') {
      return Response.json(
        { erro: 'util obrigatório (boolean): 👍=true / 👎=false' },
        { status: 400 }
      );
    }
    const texto =
      typeof body.texto === 'string' && body.texto.trim() !== ''
        ? body.texto.trim()
        : null;

    const analise = await deps.analysisRepo.buscarPorJobId(jobId);
    if (!analise) {
      return Response.json(
        { erro: `análise do job ${jobId} não encontrada` },
        { status: 404 }
      );
    }

    // Feedback é o sinal de RESERVA (§11b) — gravação não-bloqueante: a
    // falha de telemetria não pode virar erro para a usuária.
    await registrarSeguro(deps.telemetry, analise.id, EVENTO.feedback, {
      util: body.util,
      texto,
    });

    return Response.json({ ok: true }, { status: 202 });
  };
}
