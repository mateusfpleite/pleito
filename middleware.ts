/**
 * Single-user auth middleware (SPEC §14, #7).
 *
 * RUNTIME: runs on the **Edge runtime** (the Next.js/Vercel default for
 * middleware). That's why the cookie check uses `lib/sessao.ts`, which is
 * **Web Crypto API** (`crypto.subtle`) — `node:crypto` does NOT exist on
 * the Edge. The pure decision lives in `lib/middleware-auth.ts` (tested
 * without a server); here we only do the I/O (read cookie, redirect/401).
 *
 * We read `APP_SECRET` straight from `process.env` (not via `getConfig()`)
 * so we don't drag the full env schema (DATABASE_URL etc., only relevant
 * on Node/Prisma) into the Edge bundle. If `APP_SECRET` is missing, it
 * FAILS CLOSED: blocks everything (except public routes).
 *
 * Protects all routes except `/login`, `/api/login`, `/api/health`
 * (includes `/admin`, which Phase 15 deliberately left open).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { deveBloquear } from './lib/middleware-auth.ts';
import { NOME_COOKIE_SESSAO } from './lib/sessao.ts';

export const config = {
  // Runs on everything except Next's static assets and the favicon. The
  // auth exceptions (/login, /api/login, /api/health) are handled
  // inside `deveBloquear` (public = allow).
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  const secret = process.env.APP_SECRET ?? '';
  const cookie = req.cookies.get(NOME_COOKIE_SESSAO)?.value;

  // No APP_SECRET configured: fails closed. `verificarSessao` with
  // secret '' never matches a legitimate cookie ⇒ deveBloquear blocks.
  const acao = await deveBloquear(pathname, cookie, secret);

  if (acao === 'liberar') return NextResponse.next();

  if (acao === 'unauthorized') {
    return NextResponse.json(
      { erro: 'não autenticado' },
      { status: 401 }
    );
  }

  // redirect: protected navigation without a session → 302 to /login.
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}
