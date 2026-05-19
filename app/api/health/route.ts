/**
 * GET /api/health — liveness probe (SPEC §14). Public (no session
 * required): used by uptime/monitoring and as a signal that the app is
 * up. No dependencies (does not touch the DB) to be cheap and reliable.
 */
export const runtime = 'nodejs';

export function GET(): Response {
  return Response.json({ ok: true }, { status: 200 });
}
