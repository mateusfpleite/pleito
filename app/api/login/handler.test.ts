import { describe, it, expect } from 'vitest';
import { criarLoginPOST } from './handler.ts';
import { verificarSessao, NOME_COOKIE_SESSAO } from '../../../lib/sessao.ts';

/**
 * DETERMINISTIC tests of POST /api/login (SPEC §14). No server. They
 * prove: correct password → 200 + a SIGNED session Set-Cookie (verified
 * via verificarSessao); wrong/absent password → 401 WITHOUT Set-Cookie;
 * correct password comparison (timing-safe tested by correctness, not by
 * timing); invalid body → 400.
 */

const SECRET = 'minha-senha-de-teste-123';

function req(body: unknown): Request {
  return new Request('http://localhost/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/login', () => {
  it('correct password → 200 + valid signed session Set-Cookie', async () => {
    const POST = criarLoginPOST({ appSecret: SECRET, producao: false });
    const res = await POST(req({ senha: SECRET }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const sc = res.headers.get('set-cookie');
    expect(sc).toBeTruthy();
    expect(sc).toContain(`${NOME_COOKIE_SESSAO}=`);
    expect(sc).toContain('HttpOnly');
    expect(sc).toContain('SameSite=Lax');
    expect(sc).toContain('Path=/');
    // dev → no Secure
    expect(sc).not.toContain('Secure');

    // The cookie value is a valid HMAC session against the secret.
    const m = /pleito_sessao=([^;]+)/.exec(sc as string);
    expect(m).toBeTruthy();
    const r = await verificarSessao((m as RegExpExecArray)[1], SECRET);
    expect(r.valido).toBe(true);
  });

  it('production → Secure cookie', async () => {
    const POST = criarLoginPOST({ appSecret: SECRET, producao: true });
    const res = await POST(req({ senha: SECRET }));
    expect(res.headers.get('set-cookie')).toContain('Secure');
  });

  it('wrong password → 401 WITHOUT Set-Cookie', async () => {
    const POST = criarLoginPOST({ appSecret: SECRET, producao: false });
    const res = await POST(req({ senha: 'errada' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('password of the same length but different → 401', async () => {
    const POST = criarLoginPOST({ appSecret: 'abcde', producao: false });
    const res = await POST(req({ senha: 'abcdz' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('password absent / non-string → 401 without cookie', async () => {
    const POST = criarLoginPOST({ appSecret: SECRET, producao: false });
    for (const b of [{}, { senha: 123 }, { senha: null }]) {
      const res = await POST(req(b));
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
  });

  it('non-JSON body → 400', async () => {
    const POST = criarLoginPOST({ appSecret: SECRET, producao: false });
    const res = await POST(req('isto não é json'));
    expect(res.status).toBe(400);
  });
});
