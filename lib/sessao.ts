/**
 * Assinatura/verificação de cookie de sessão single-user (SPEC §14, #7).
 *
 * Universal: usa **Web Crypto API** (`crypto.subtle` HMAC-SHA256), que
 * está disponível tanto no Edge runtime (middleware Next.js) quanto no
 * Node runtime (rotas Prisma) e no Vercel. Por isso este módulo NÃO
 * importa `node:crypto` — o middleware roda no Edge por padrão e
 * `node:crypto` não existe lá. Mantê-lo Web-Crypto-only garante que a
 * MESMA lógica de verificação rode no middleware e nos handlers.
 *
 * Cookie = `${payloadB64url}.${hmacB64url}` onde `payload` é JSON
 * `{ exp: <epoch ms> }` e o HMAC cobre o payload codificado. Verificação:
 * recomputa o HMAC e compara em tempo constante (defesa contra timing
 * em forja de assinatura); checa expiração. Tudo puro/determinístico —
 * testável sem servidor.
 */

export const NOME_COOKIE_SESSAO = 'pleito_sessao';

/** Duração padrão da sessão: 7 dias. */
export const DURACAO_SESSAO_MS = 7 * 24 * 60 * 60 * 1000;

export type ResultadoVerificacao = {
  valido: boolean;
  /** true quando a assinatura confere mas o `exp` já passou. */
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

/** Comparação em tempo constante de duas strings ASCII (b64url). */
function igualTempoConstante(a: string, b: string): boolean {
  // Compara sempre o mesmo nº de iterações: o tamanho não-igual é
  // detectado por flag, sem early-return dependente de conteúdo.
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Gera o valor do cookie de sessão, assinado com HMAC sobre o `secret`.
 * `agora` injetável p/ testes determinísticos. Default: expira em 7d.
 */
export async function assinarSessao(
  secret: string,
  opts: { agora?: number; duracaoMs?: number } = {}
): Promise<string> {
  // GUARD EXPLÍCITO (I1): NUNCA assinar com secret vazio/ausente —
  // emitir um cookie HMAC com chave vazia seria emitir credencial
  // insegura (forjável trivialmente). Fail-closed INTENCIONAL: lança
  // ANTES de qualquer crypto.subtle, sem depender do `DataError`
  // incidental da Web Crypto p/ chave de tamanho zero. Callers
  // legítimos (handler de login) só assinam após validar a senha
  // contra `APP_SECRET`, que o schema de config exige não-vazio
  // (z.string().min(1)) — logo este throw não quebra fluxo válido.
  if (!secret) {
    throw new Error(
      'assinarSessao: APP_SECRET ausente/vazio — recusando assinar ' +
        'cookie de sessão inseguro (fail-closed)'
    );
  }
  const agora = opts.agora ?? Date.now();
  const exp = agora + (opts.duracaoMs ?? DURACAO_SESSAO_MS);
  const payloadB64 = b64urlEncode(enc.encode(JSON.stringify({ exp })));
  const sig = await hmac(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

/**
 * Verifica o cookie: assinatura HMAC válida (tempo constante) E não
 * expirado. Cookie ausente/malformado/adulterado/secret errado →
 * `{ valido: false }`. Assinatura OK mas vencido →
 * `{ valido: false, expirado: true }`.
 */
export async function verificarSessao(
  cookie: string | undefined | null,
  secret: string,
  opts: { agora?: number } = {}
): Promise<ResultadoVerificacao> {
  // GUARD EXPLÍCITO (I1): secret vazio/ausente ⇒ fail-closed
  // INTENCIONAL e imediato. Esta é a garantia PRIMÁRIA de que um
  // misconfig de `APP_SECRET` (env faltando no Edge/middleware) nunca
  // aceita um cookie — em vez de depender do side-effect não
  // documentado de `crypto.subtle.importKey` lançar p/ chave vazia
  // (mascarado pelo `catch` amplo abaixo, que confundiria misconfig
  // com cookie meramente "inválido"). O try/catch em volta de hmac()
  // permanece como defesa secundária, mas este guard vem ANTES.
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
