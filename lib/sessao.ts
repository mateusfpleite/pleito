/**
 * Single-user session-cookie signing/verification (SPEC §14, #7).
 *
 * Universal: uses the **Web Crypto API** (`crypto.subtle` HMAC-SHA256),
 * which is available both in the Edge runtime (Next.js middleware) and
 * the Node runtime (Prisma routes) and on Vercel. That is why this module
 * does NOT import `node:crypto` — the middleware runs on the Edge by
 * default and `node:crypto` does not exist there. Keeping it Web-Crypto-
 * only guarantees that the SAME verification logic runs in the middleware
 * and in the handlers.
 *
 * Cookie = `${payloadB64url}.${hmacB64url}` where `payload` is JSON
 * `{ exp: <epoch ms> }` and the HMAC covers the encoded payload.
 * Verification: recomputes the HMAC and compares in constant time
 * (defense against timing attacks on signature forgery); checks
 * expiration. Everything is pure/deterministic — testable without a
 * server.
 */

export const NOME_COOKIE_SESSAO = 'pleito_sessao';

/** Default session lifetime: 7 days. */
export const DURACAO_SESSAO_MS = 7 * 24 * 60 * 60 * 1000;

export type ResultadoVerificacao = {
  valido: boolean;
  /** true when the signature matches but `exp` has already passed. */
  expirado?: boolean;
};

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const enc = new TextEncoder();

async function hmac(payloadB64: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64));
  return b64urlEncode(new Uint8Array(sig));
}

/** Constant-time comparison of two ASCII strings (b64url). */
function igualTempoConstante(a: string, b: string): boolean {
  // Always compares the same number of iterations: a length mismatch is
  // detected via a flag, without a content-dependent early return.
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Builds the session-cookie value, signed with HMAC over `secret`.
 * `agora` is injectable for deterministic tests. Default: expires in 7d.
 */
export async function assinarSessao(
  secret: string,
  opts: { agora?: number; duracaoMs?: number } = {}
): Promise<string> {
  // EXPLICIT GUARD (I1): NEVER sign with an empty/missing secret —
  // issuing an HMAC cookie with an empty key would issue an insecure
  // credential (trivially forgeable). INTENTIONAL fail-closed: throws
  // BEFORE any crypto.subtle, without relying on Web Crypto's incidental
  // `DataError` for a zero-length key. Legitimate callers (the login
  // handler) only sign after validating the password against
  // `APP_SECRET`, which the config schema requires to be non-empty
  // (z.string().min(1)) — so this throw never breaks a valid flow.
  if (!secret) {
    throw new Error(
      'assinarSessao: APP_SECRET missing/empty — refusing to sign an ' +
        'insecure session cookie (fail-closed)'
    );
  }
  const agora = opts.agora ?? Date.now();
  const exp = agora + (opts.duracaoMs ?? DURACAO_SESSAO_MS);
  const payloadB64 = b64urlEncode(enc.encode(JSON.stringify({ exp })));
  const sig = await hmac(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

/**
 * Verifies the cookie: valid HMAC signature (constant time) AND not
 * expired. Missing/malformed/tampered cookie or wrong secret →
 * `{ valido: false }`. Valid signature but expired →
 * `{ valido: false, expirado: true }`.
 */
export async function verificarSessao(
  cookie: string | undefined | null,
  secret: string,
  opts: { agora?: number } = {}
): Promise<ResultadoVerificacao> {
  // EXPLICIT GUARD (I1): empty/missing secret ⇒ INTENTIONAL, immediate
  // fail-closed. This is the PRIMARY guarantee that an `APP_SECRET`
  // misconfig (env missing on the Edge/middleware) never accepts a
  // cookie — instead of relying on the undocumented side effect of
  // `crypto.subtle.importKey` throwing for an empty key (masked by the
  // broad `catch` below, which would confuse a misconfig with a merely
  // "invalid" cookie). The try/catch around hmac() remains as a
  // secondary defense, but this guard comes FIRST.
  if (!secret) return { valido: false };
  if (!cookie || typeof cookie !== 'string') return { valido: false };
  const ponto = cookie.indexOf('.');
  if (ponto <= 0 || ponto === cookie.length - 1) return { valido: false };
  const payloadB64 = cookie.slice(0, ponto);
  const sig = cookie.slice(ponto + 1);

  let esperado: string;
  try {
    esperado = await hmac(payloadB64, secret);
  } catch {
    return { valido: false };
  }
  if (!igualTempoConstante(sig, esperado)) return { valido: false };

  let exp: unknown;
  try {
    const dec = new TextDecoder().decode(b64urlDecode(payloadB64));
    exp = (JSON.parse(dec) as { exp?: unknown }).exp;
  } catch {
    return { valido: false };
  }
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    return { valido: false };
  }

  const agora = opts.agora ?? Date.now();
  if (agora >= exp) return { valido: false, expirado: true };
  return { valido: true };
}
