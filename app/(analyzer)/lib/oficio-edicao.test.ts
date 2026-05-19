import { describe, it, expect } from 'vitest';
import {
  inicializarEdicao,
  editarTexto,
  reverter,
  foiEditado,
} from './oficio-edicao.ts';

/**
 * Estado da edição human-in-the-loop do ofício (SPEC §8). Phase 13 só
 * entrega a textarea EDITÁVEL + estado local controlado; o export é
 * Phase 14. Testa: estado controlado (texto muda), detecção de
 * "foi editado" (sinal de diff p/ §11b futuro) e reverter ao gerado.
 */

describe('edição do ofício — textarea controlada', () => {
  it('inicializa com o markdown gerado pelo Drafter', () => {
    const e = inicializarEdicao('# Ofício\nCorpo gerado');
    expect(e.texto).toBe('# Ofício\nCorpo gerado');
    expect(e.original).toBe('# Ofício\nCorpo gerado');
    expect(foiEditado(e)).toBe(false);
  });

  it('editarTexto atualiza o texto (estado controlado)', () => {
    let e = inicializarEdicao('original');
    e = editarTexto(e, 'texto editado pela Stefany');
    expect(e.texto).toBe('texto editado pela Stefany');
    expect(e.original).toBe('original');
    expect(foiEditado(e)).toBe(true);
  });

  it('foiEditado é false se voltar ao texto original', () => {
    let e = inicializarEdicao('abc');
    e = editarTexto(e, 'abc xyz');
    expect(foiEditado(e)).toBe(true);
    e = editarTexto(e, 'abc');
    expect(foiEditado(e)).toBe(false);
  });

  it('reverter restaura o markdown gerado', () => {
    let e = inicializarEdicao('gerado');
    e = editarTexto(e, 'rabiscado');
    e = reverter(e);
    expect(e.texto).toBe('gerado');
    expect(foiEditado(e)).toBe(false);
  });

  it('texto vazio é um estado de edição válido (controlado)', () => {
    let e = inicializarEdicao('algo');
    e = editarTexto(e, '');
    expect(e.texto).toBe('');
    expect(foiEditado(e)).toBe(true);
  });
});
