import { describe, it, expect } from 'vitest';
import {
  assinarSessao,
  verificarSessao,
  DURACAO_SESSAO_MS,
} from './sessao.ts';

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
  it('round-trip: assina e verifica OK dentro da validade', async () => {
    const cookie = await assinarSessao(SECRET, { agora: T0 });
    const r = await verificarSessao(cookie, SECRET, { agora: T0 + 1000 });
    expect(r).toEqual({ valido: true });
  });

  it('cookie adulterado (payload trocado) → inválido', async () => {
    const cookie = await assinarSessao(SECRET, { agora: T0 });
    const [, sig] = cookie.split('.');
    const forjado = `${btoa('{"exp":99999999999999}')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')}.${sig}`;
    const r = await verificarSessao(forjado, SECRET, { agora: T0 });
    expect(r.valido).toBe(false);
  });

  it('assinatura adulterada → inválido', async () => {
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

  it('secret errado → inválido (sem vazar expirado)', async () => {
    const cookie = await assinarSessao(SECRET, { agora: T0 });
    const r = await verificarSessao(cookie, 'outro-secret', {
      agora: T0,
    });
    expect(r).toEqual({ valido: false });
  });

  it('cookie ausente/null/vazio/malformado → inválido', async () => {
    for (const c of [undefined, null, '', 'semponto', '.só-sig', 'payload.']) {
      const r = await verificarSessao(
        c as string | undefined,
        SECRET,
        { agora: T0 }
      );
      expect(r.valido).toBe(false);
    }
  });

  it('duração padrão é 7 dias', async () => {
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
