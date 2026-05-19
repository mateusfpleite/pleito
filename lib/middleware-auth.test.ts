import { describe, it, expect } from 'vitest';
import { deveBloquear, ehRotaPublica } from './middleware-auth.ts';
import { assinarSessao } from './sessao.ts';

/**
 * DETERMINISTIC tests of the middleware's pure decision (SPEC §14). No
 * server. They prove the matrix: public without cookie → allow; protected
 * without/invalid cookie → block (401 for /api/*, redirect for
 * navigation); protected with valid cookie → allow; /admin is protected.
 */

const SECRET = 'secret-mid';
const T0 = 1_700_000_000_000;

describe('ehRotaPublica', () => {
  it('only /login, /api/login, /api/health are public', () => {
    expect(ehRotaPublica('/login')).toBe(true);
    expect(ehRotaPublica('/api/login')).toBe(true);
    expect(ehRotaPublica('/api/health')).toBe(true);
    expect(ehRotaPublica('/')).toBe(false);
    expect(ehRotaPublica('/admin')).toBe(false);
    expect(ehRotaPublica('/api/job')).toBe(false);
    // no prefix match: /login/x is not public
    expect(ehRotaPublica('/login/extra')).toBe(false);
  });
});

describe('deveBloquear', () => {
  it('public route without cookie → liberar', async () => {
    for (const p of ['/login', '/api/login', '/api/health']) {
      expect(await deveBloquear(p, undefined, SECRET)).toBe('liberar');
    }
  });

  it('protected navigation without cookie → redirect (/login)', async () => {
    expect(await deveBloquear('/', undefined, SECRET)).toBe('redirect');
    expect(await deveBloquear('/admin', undefined, SECRET)).toBe(
      'redirect'
    );
  });

  it('protected /api/* without cookie → unauthorized (401)', async () => {
    expect(await deveBloquear('/api/job', undefined, SECRET)).toBe(
      'unauthorized'
    );
    expect(
      await deveBloquear('/api/status/abc', null, SECRET)
    ).toBe('unauthorized');
  });

  it('invalid cookie on protected route → blocks', async () => {
    expect(await deveBloquear('/', 'lixo.invalido', SECRET)).toBe(
      'redirect'
    );
    expect(
      await deveBloquear('/api/job', 'lixo.invalido', SECRET)
    ).toBe('unauthorized');
  });

  it('valid cookie on protected route → liberar', async () => {
    const cookie = await assinarSessao(SECRET, { agora: T0 });
    expect(
      await deveBloquear('/', cookie, SECRET, { agora: T0 + 1000 })
    ).toBe('liberar');
    expect(
      await deveBloquear('/admin', cookie, SECRET, { agora: T0 + 1000 })
    ).toBe('liberar');
    expect(
      await deveBloquear('/api/job', cookie, SECRET, { agora: T0 + 1000 })
    ).toBe('liberar');
  });

  it('expired cookie on protected route → blocks', async () => {
    const cookie = await assinarSessao(SECRET, {
      agora: T0,
      duracaoMs: 1000,
    });
    expect(
      await deveBloquear('/', cookie, SECRET, { agora: T0 + 5000 })
    ).toBe('redirect');
  });

  it('wrong secret on protected route → blocks', async () => {
    const cookie = await assinarSessao('outro', { agora: T0 });
    expect(
      await deveBloquear('/api/job', cookie, SECRET, { agora: T0 })
    ).toBe('unauthorized');
  });
});
