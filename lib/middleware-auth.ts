/**
 * PURE auth-middleware blocking decision (SPEC §14, #7).
 *
 * Extracted from `middleware.ts` to be testable without booting a server:
 * given the path, the session cookie value and the secret, it decides
 *   - `liberar`   → proceed (public route OR valid cookie);
 *   - `redirect`  → 302 to /login (protected navigation without session);
 *   - `unauthorized` → 401 (protected /api/* route without session).
 *
 * Public (no session required): `/login`, `/api/login`, `/api/health`.
 * Everything else — including `/admin` (Phase 15 deliberately left open)
 * — requires a session cookie with a valid, non-expired HMAC.
 *
 * Uses `verificarSessao` (Web Crypto) → compatible with the Edge runtime.
 */
import { verificarSessao } from './sessao.ts';

export type AcaoAuth = 'liberar' | 'redirect' | 'unauthorized';

const ROTAS_PUBLICAS = new Set(['/login', '/api/login', '/api/health']);

/** Does the route skip the session check? (exact match — no wildcard prefixes). */
export function ehRotaPublica(path: string): boolean {
  return ROTAS_PUBLICAS.has(path);
}

/**
 * Decides what the middleware should do.
 * - Public route → always `liberar` (even without a cookie).
 * - Protected route + valid session → `liberar`.
 * - Protected route + missing/invalid/expired session:
 *     - path starts with `/api/` → `unauthorized` (401);
 *     - otherwise (navigation) → `redirect` (302 → /login).
 */
export async function deveBloquear(
  path: string,
  cookie: string | undefined | null,
  secret: string,
  opts: { agora?: number } = {}
): Promise<AcaoAuth> {
  if (ehRotaPublica(path)) return 'liberar';

  const { valido } = await verificarSessao(cookie, secret, opts);
  if (valido) return 'liberar';

  return path.startsWith('/api/') ? 'unauthorized' : 'redirect';
}
