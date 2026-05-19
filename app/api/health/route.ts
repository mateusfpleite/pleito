/**
 * GET /api/health — liveness probe (SPEC §14). Público (não exige
 * sessão): usado pelo uptime/monitoramento e como sinal de que a app
 * está de pé. Sem dependências (não toca DB) p/ ser barato e confiável.
 */
export const runtime = 'nodejs';

export function GET(): Response {
  return Response.json({ ok: true }, { status: 200 });
}
