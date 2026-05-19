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

describe('calcularDiffOficio — sinal-ouro + fallback de sinal vazio', () => {
  it('(a) gerado === exportado → foiEditado=false (sinal-ouro nulo)', () => {
    const t = '# Ofício\n\nLinha um.\nLinha dois.';
    const d = calcularDiffOficio(t, t);
    expect(d.foiEditado).toBe(false);
    expect(d.distanciaCaracteres).toBe(0);
    expect(d.linhasAdicionadas).toBe(0);
    expect(d.linhasRemovidas).toBe(0);
    expect(d.tamanhoGerado).toBe(t.length);
    expect(d.tamanhoExportado).toBe(t.length);
  });

  it('(b) exportado=null (não exportou) → foiEditado=false, exportado vazio', () => {
    const g = '# Ofício\n\nTexto gerado.';
    const d = calcularDiffOficio(g, null);
    expect(d.foiEditado).toBe(false);
    expect(d.distanciaCaracteres).toBe(0);
    expect(d.tamanhoExportado).toBe(0);
    expect(d.tamanhoGerado).toBe(g.length);
  });

  it('(c) edição real → foiEditado=true + distância e linhas > 0', () => {
    const g = '# Ofício\n\nQual a vigência da Lei 8.666?';
    const e = '# Ofício de Impugnação\n\nQual a vigência da Lei 8.666?';
    const d = calcularDiffOficio(g, e);
    expect(d.foiEditado).toBe(true);
    expect(d.distanciaCaracteres).toBeGreaterThan(0);
    // 1 linha trocada → 1 adicionada + 1 removida (LCS preserva as iguais).
    expect(d.linhasAdicionadas).toBe(1);
    expect(d.linhasRemovidas).toBe(1);
  });

  it('(d) linha NOVA inserida → +1 adicionada, 0 removida', () => {
    const g = 'a\nb\nc';
    const e = 'a\nb\nNOVA\nc';
    const d = calcularDiffOficio(g, e);
    expect(d.foiEditado).toBe(true);
    expect(d.linhasAdicionadas).toBe(1);
    expect(d.linhasRemovidas).toBe(0);
  });

  it('(d) linha REMOVIDA → 0 adicionada, +1 removida', () => {
    const g = 'a\nb\nc';
    const e = 'a\nc';
    const d = calcularDiffOficio(g, e);
    expect(d.foiEditado).toBe(true);
    expect(d.linhasAdicionadas).toBe(0);
    expect(d.linhasRemovidas).toBe(1);
  });

  it('(e) só diferença CRLF → NÃO conta como edição (normalizado)', () => {
    const g = 'linha1\nlinha2';
    const e = 'linha1\r\nlinha2';
    const d = calcularDiffOficio(g, e);
    expect(d.foiEditado).toBe(false);
    expect(d.distanciaCaracteres).toBe(0);
  });
});
