import { describe, it, expect } from 'vitest';
import { calcularDiffOficio } from './oficio-diff.ts';

/**
 * Testes DETERMINÍSTICOS do diff sinal-ouro (SPEC §11b). Cálculo puro —
 * sem LLM/rede (testing-anti-patterns: prova-se a métrica, não um modelo).
 * Invariantes:
 *  (a) gerado === exportado → foiEditado=false (sinal-ouro NULO);
 *  (b) exportado=null (não exportou) → foiEditado=false (cai no reserva);
 *  (c) edição real → foiEditado=true, distância>0, linhas contadas;
 *  (d) linha adicionada/removida contadas via LCS;
 *  (e) CRLF normalizado (não conta como edição falsa).
 */

describe('calcularDiffOficio — gold-signal + empty-signal fallback', () => {
  it('(a) generated === exported → foiEditado=false (gold-signal null)', () => {
    const t = '# Ofício\n\nLinha um.\nLinha dois.';
    const d = calcularDiffOficio(t, t);
    expect(d.foiEditado).toBe(false);
    expect(d.distanciaCaracteres).toBe(0);
    expect(d.linhasAdicionadas).toBe(0);
    expect(d.linhasRemovidas).toBe(0);
    expect(d.tamanhoGerado).toBe(t.length);
    expect(d.tamanhoExportado).toBe(t.length);
  });

  it('(b) exported=null (did not export) → foiEditado=false, exported empty', () => {
    const g = '# Ofício\n\nTexto gerado.';
    const d = calcularDiffOficio(g, null);
    expect(d.foiEditado).toBe(false);
    expect(d.distanciaCaracteres).toBe(0);
    expect(d.tamanhoExportado).toBe(0);
    expect(d.tamanhoGerado).toBe(g.length);
  });

  it('(c) real edit → foiEditado=true + distance and lines > 0', () => {
    const g = '# Ofício\n\nQual a vigência da Lei 8.666?';
    const e = '# Ofício de Impugnação\n\nQual a vigência da Lei 8.666?';
    const d = calcularDiffOficio(g, e);
    expect(d.foiEditado).toBe(true);
    expect(d.distanciaCaracteres).toBeGreaterThan(0);
    // 1 linha trocada → 1 adicionada + 1 removida (LCS preserva as iguais).
    expect(d.linhasAdicionadas).toBe(1);
    expect(d.linhasRemovidas).toBe(1);
  });

  it('(d) NEW line inserted → +1 added, 0 removed', () => {
    const g = 'a\nb\nc';
    const e = 'a\nb\nNOVA\nc';
    const d = calcularDiffOficio(g, e);
    expect(d.foiEditado).toBe(true);
    expect(d.linhasAdicionadas).toBe(1);
    expect(d.linhasRemovidas).toBe(0);
  });

  it('(d) line REMOVED → 0 added, +1 removed', () => {
    const g = 'a\nb\nc';
    const e = 'a\nc';
    const d = calcularDiffOficio(g, e);
    expect(d.foiEditado).toBe(true);
    expect(d.linhasAdicionadas).toBe(0);
    expect(d.linhasRemovidas).toBe(1);
  });

  it('(e) only CRLF difference → does NOT count as an edit (normalized)', () => {
    const g = 'linha1\nlinha2';
    const e = 'linha1\r\nlinha2';
    const d = calcularDiffOficio(g, e);
    expect(d.foiEditado).toBe(false);
    expect(d.distanciaCaracteres).toBe(0);
  });
});
