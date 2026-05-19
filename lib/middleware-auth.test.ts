import { describe, it, expect } from 'vitest';
import { deveBloquear, ehRotaPublica } from './middleware-auth.ts';
import { assinarSessao } from './sessao.ts';

/**
 * Testes DETERMINÍSTICOS da decisão pura do middleware (SPEC §14).
 * Sem servidor. Provam a matriz: pública sem cookie → libera; protegida
 * sem/cookie inválido → bloqueia (401 p/ /api/*, redirect p/ navegação);
 * protegida com cookie válido → libera; /admin é protegida.
 */

const SECRET = 'secret-mid';
const T0 = 1_700_000_000_000;

describe('ehRotaPublica', () => {
  it('só /login, /api/login, /api/health são públicas', () => {
    expect(ehRotaPublica('/login')).toBe(true);
    expect(ehRotaPublica('/api/login')).toBe(true);
    expect(ehRotaPublica('/api/health')).toBe(true);
    expect(ehRotaPublica('/')).toBe(false);
    expect(ehRotaPublica('/admin')).toBe(false);
    expect(ehRotaPublica('/api/job')).toBe(false);
    // sem match por prefixo: /login/x não é pública
    expect(ehRotaPublica('/login/extra')).toBe(false);
  });
});

describe('deveBloquear', () => {
  it('rota pública sem cookie → liberar', async () => {
    for (const p of ['/login', '/api/login', '/api/health']) {
      expect(await deveBloquear(p, undefined, SECRET)).toBe('liberar');
    }
  });

  it('navegação protegida sem cookie → redirect (/login)', async () => {
    expect(await deveBloquear('/', undefined, SECRET)).toBe('redirect');
    expect(await deveBloquear('/admin', undefined, SECRET)).toBe(
      'redirect'
    );
  });

  it('/api/* protegida sem cookie → unauthorized (401)', async () => {
    expect(await deveBloquear('/api/job', undefined, SECRET)).toBe(
      'unauthorized'
    );
    expect(
      await deveBloquear('/api/status/abc', null, SECRET)
    ).toBe('unauthorized');
  });

  it('cookie inválido em rota protegida → bloqueia', async () => {
    expect(await deveBloquear('/', 'lixo.invalido', SECRET)).toBe(
      'redirect'
    );
    expect(
      await deveBloquear('/api/job', 'lixo.invalido', SECRET)
    ).toBe('unauthorized');
  });

  it('cookie válido em rota protegida → liberar', async () => {
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

  it('cookie expirado em rota protegida → bloqueia', async () => {
    const cookie = await assinarSessao(SECRET, {
      agora: T0,
      duracaoMs: 1000,
    });
    expect(
      await deveBloquear('/', cookie, SECRET, { agora: T0 + 5000 })
    ).toBe('redirect');
  });

  it('secret errado em rota protegida → bloqueia', async () => {
    const cookie = await assinarSessao('outro', { agora: T0 });
    expect(
      await deveBloquear('/api/job', cookie, SECRET, { agora: T0 })
    ).toBe('unauthorized');
  });
});
