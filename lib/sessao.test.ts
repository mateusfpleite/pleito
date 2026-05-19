import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  assinarSessao,
  verificarSessao,
  DURACAO_SESSAO_MS,
} from './sessao.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Testes DETERMINÍSTICOS da assinatura/verificação de sessão (SPEC §14).
 * Sem servidor: lógica pura HMAC (Web Crypto) com `agora` injetado.
 * Provam: round-trip OK; adulteração → inválido; expirado → inválido
 * (flag `expirado`); secret errado → inválido; cookie ausente/malformado
 * → inválido.
 */

const SECRET = 'segredo-super-secreto-de-teste';
const T0 = 1_700_000_000_000;

describe('sessao: assinar → verificar', () => {
  it('round-trip: signs and verifies OK within the validity period', async () => {
    const cookie = await assinarSessao(SECRET, { agora: T0 });
    const r = await verificarSessao(cookie, SECRET, { agora: T0 + 1000 });
    expect(r).toEqual({ valido: true });
  });

  it('tampered cookie (payload swapped) → invalid', async () => {
    const cookie = await assinarSessao(SECRET, { agora: T0 });
    const [, sig] = cookie.split('.');
    const forjado = `${btoa('{"exp":99999999999999}')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')}.${sig}`;
    const r = await verificarSessao(forjado, SECRET, { agora: T0 });
    expect(r.valido).toBe(false);
  });

  it('tampered signature → invalid', async () => {
    const cookie = await assinarSessao(SECRET, { agora: T0 });
    const [payload] = cookie.split('.');
    const r = await verificarSessao(
      `${payload}.AAAAdeadbeef`,
      SECRET,
      { agora: T0 }
    );
    expect(r.valido).toBe(false);
  });

  it('expirado → { valido:false, expirado:true }', async () => {
    const cookie = await assinarSessao(SECRET, {
      agora: T0,
      duracaoMs: 1000,
    });
    const r = await verificarSessao(cookie, SECRET, { agora: T0 + 2000 });
    expect(r).toEqual({ valido: false, expirado: true });
  });

  it('wrong secret → invalid (without leaking expired)', async () => {
    const cookie = await assinarSessao(SECRET, { agora: T0 });
    const r = await verificarSessao(cookie, 'outro-secret', {
      agora: T0,
    });
    expect(r).toEqual({ valido: false });
  });

  it('cookie absent/null/empty/malformed → invalid', async () => {
    for (const c of [undefined, null, '', 'semponto', '.só-sig', 'payload.']) {
      const r = await verificarSessao(
        c as string | undefined,
        SECRET,
        { agora: T0 }
      );
      expect(r.valido).toBe(false);
    }
  });

  it('I1: verificarSessao with empty secret → invalid (explicit fail-closed)', async () => {
    // O GUARD explícito deve retornar ANTES de qualquer HMAC: prova-se
    // espionando crypto.subtle.importKey. Se a falha dependesse só do
    // side-effect do importKey lançar p/ chave vazia, importKey SERIA
    // chamado — este spy garante que NÃO é (guard vem antes).
    const spy = vi.spyOn(crypto.subtle, 'importKey');

    const cookieValido = await assinarSessao(SECRET, { agora: T0 });
    spy.mockClear();

    expect(await verificarSessao(cookieValido, '', { agora: T0 })).toEqual({
      valido: false,
    });
    // Caminho que NÃO depende do throw de importKey: o guard explícito
    // retorna ANTES de chegar a qualquer parsing/HMAC.
    expect(
      await verificarSessao('payload.assinatura', '', { agora: T0 })
    ).toEqual({ valido: false });
    // secret undefined (env ausente) idem.
    expect(
      await verificarSessao(cookieValido, undefined as unknown as string, {
        agora: T0,
      })
    ).toEqual({ valido: false });

    // Prova do guard explícito: HMAC nunca foi invocado p/ secret vazio.
    expect(spy).not.toHaveBeenCalled();
  });

  it('I1: assinarSessao with empty secret THROWS (does not emit an insecure cookie)', async () => {
    // Deve lançar pelo GUARD explícito — ANTES de tocar importKey
    // (não confiar no DataError incidental da Web Crypto).
    const spy = vi.spyOn(crypto.subtle, 'importKey');
    await expect(assinarSessao('', { agora: T0 })).rejects.toThrow(
      /APP_SECRET|secret/i
    );
    await expect(
      assinarSessao(undefined as unknown as string, { agora: T0 })
    ).rejects.toThrow(/APP_SECRET|secret/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('default duration is 7 days', async () => {
    const cookie = await assinarSessao(SECRET, { agora: T0 });
    const seteDiasMenos1s = await verificarSessao(cookie, SECRET, {
      agora: T0 + DURACAO_SESSAO_MS - 1000,
    });
    expect(seteDiasMenos1s.valido).toBe(true);
    const depois = await verificarSessao(cookie, SECRET, {
      agora: T0 + DURACAO_SESSAO_MS + 1,
    });
    expect(depois.valido).toBe(false);
    expect(depois.expirado).toBe(true);
  });
});
