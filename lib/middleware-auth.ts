/**
 * Decisão PURA de bloqueio do middleware de auth (SPEC §14, #7).
 *
 * Extraída do `middleware.ts` para ser testável sem subir servidor: dado
 * o path, o valor do cookie de sessão e o secret, decide
 *   - `liberar`   → segue (rota pública OU cookie válido);
 *   - `redirect`  → 302 p/ /login (navegação protegida sem sessão);
 *   - `unauthorized` → 401 (rota /api/* protegida sem sessão).
 *
 * Públicas (não exigem sessão): `/login`, `/api/login`, `/api/health`.
 * Tudo o mais — incluindo `/admin` (Phase 15 ficou aberto de propósito)
 * — exige cookie de sessão com HMAC válido e não expirado.
 *
 * Usa `verificarSessao` (Web Crypto) → compatível com Edge runtime.
 */
import { verificarSessao } from './sessao.ts';

export type AcaoAuth = 'liberar' | 'redirect' | 'unauthorized';

const ROTAS_PUBLICAS = new Set(['/login', '/api/login', '/api/health']);

/** Rota dispensa sessão? (match exato — sem prefixos curinga). */
export function ehRotaPublica(path: string): boolean {
  return ROTAS_PUBLICAS.has(path);
}

/**
 * Decide o que o middleware deve fazer.
 * - Rota pública → sempre `liberar` (mesmo sem cookie).
 * - Rota protegida + sessão válida → `liberar`.
 * - Rota protegida + sem sessão/ inválida/expirada:
 *     - path começa com `/api/` → `unauthorized` (401);
 *     - caso contrário (navegação) → `redirect` (302 → /login).
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
