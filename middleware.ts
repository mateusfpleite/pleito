/**
 * Middleware de auth single-user (SPEC §14, #7).
 *
 * RUNTIME: roda no **Edge runtime** (padrão do Next.js/Vercel para
 * middleware). Por isso a verificação do cookie usa `lib/sessao.ts`, que
 * é **Web Crypto API** (`crypto.subtle`) — `node:crypto` NÃO existe no
 * Edge. A decisão pura está em `lib/middleware-auth.ts` (testada sem
 * servidor); aqui só fazemos o I/O (ler cookie, redirecionar/401).
 *
 * Lemos `APP_SECRET` direto de `process.env` (não via `getConfig()`)
 * para não arrastar o schema completo de env (DATABASE_URL etc., só
 * relevante no Node/Prisma) para o bundle do Edge. Se `APP_SECRET`
 * faltar, FALHA FECHADO: bloqueia tudo (exceto rotas públicas).
 *
 * Protege todas as rotas exceto `/login`, `/api/login`, `/api/health`
 * (inclui `/admin`, que a Phase 15 deixou aberto de propósito).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { deveBloquear } from './lib/middleware-auth.ts';
import { NOME_COOKIE_SESSAO } from './lib/sessao.ts';

export const config = {
  // Roda em tudo, menos assets estáticos do Next e o favicon. As
  // exceções de auth (/login, /api/login, /api/health) são tratadas
  // dentro de `deveBloquear` (público = libera).
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  const secret = process.env.APP_SECRET ?? '';
  const cookie = req.cookies.get(NOME_COOKIE_SESSAO)?.value;

  // Sem APP_SECRET configurado: falha fechado. `verificarSessao` com
  // secret '' nunca casa um cookie legítimo ⇒ deveBloquear bloqueia.
  const acao = await deveBloquear(pathname, cookie, secret);

  if (acao === 'liberar') return NextResponse.next();

  if (acao === 'unauthorized') {
    return NextResponse.json(
      { erro: 'não autenticado' },
      { status: 401 }
    );
  }

  // redirect: navegação protegida sem sessão → 302 p/ /login.
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}
