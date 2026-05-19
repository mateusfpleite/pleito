/**
 * Lógica testável de POST /api/login (SPEC §14, #7) — auth single-user V0.
 *
 * Body `{ senha }`. Valida a senha contra `config.APP_SECRET` em **tempo
 * constante** (`crypto.timingSafeEqual` do Node — esta rota é
 * `runtime='nodejs'`), evitando oráculo de timing na comparação. Senha
 * correta → 200 + `Set-Cookie` de sessão assinado HMAC (httpOnly,
 * SameSite=Lax, Secure em prod, 7d). Senha errada → 401 SEM `Set-Cookie`.
 *
 * Nunca loga a senha nem o `APP_SECRET`. A assinatura usa
 * `assinarSessao` (Web Crypto) — mesma lógica que o middleware verifica.
 */
import { timingSafeEqual } from 'node:crypto';
import {
  assinarSessao,
  NOME_COOKIE_SESSAO,
  DURACAO_SESSAO_MS,
} from '../../../lib/sessao.ts';

export type LoginDeps = {
  /** Segredo da app (config.APP_SECRET). */
  appSecret: string;
  /** Produção → cookie Secure. Injetável p/ teste. */
  producao: boolean;
};

/** Compara duas strings em tempo constante (length-safe via SHA reduz
 *  oráculo de tamanho: aqui usamos buffers de mesmo tamanho). */
function senhaConfere(fornecida: string, esperada: string): boolean {
  const a = Buffer.from(fornecida, 'utf8');
  const b = Buffer.from(esperada, 'utf8');
  // timingSafeEqual exige mesmo tamanho; tamanhos diferentes ⇒ não
  // confere (sem comparar conteúdo — o tamanho do APP_SECRET não é
  // segredo sensível e o early-return só ocorre no caso negativo).
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function criarLoginPOST(deps: LoginDeps) {
  return async function POST(req: Request): Promise<Response> {
    let body: { senha?: unknown };
    try {
      body = (await req.json()) as { senha?: unknown };
    } catch {
      return Response.json(
        { erro: 'body inválido: JSON esperado' },
        { status: 400 }
      );
    }

    const senha = typeof body.senha === 'string' ? body.senha : '';
    // Sempre executa o compare (mesmo com senha vazia) p/ não criar
    // um caminho de timing distinto. NÃO logar `senha`.
    if (!senhaConfere(senha, deps.appSecret)) {
      return Response.json({ erro: 'senha inválida' }, { status: 401 });
    }

    const valor = await assinarSessao(deps.appSecret);
    const maxAge = Math.floor(DURACAO_SESSAO_MS / 1000);
    const cookie =
      `${NOME_COOKIE_SESSAO}=${valor}; Path=/; HttpOnly; ` +
      `SameSite=Lax; Max-Age=${maxAge}` +
      (deps.producao ? '; Secure' : '');

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': cookie,
      },
    });
  };
}
