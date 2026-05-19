import { describe, it, expect } from 'vitest';
import {
  badgeStatusVerificado,
  corSeveridade,
  fmtMoedaBRL,
  fmtMeses,
  fmtDias,
} from './format.ts';

/**
 * Mapeadores PUROS de apresentação (sem render). O que importa testar
 * (Phase 13): statusVerificado→badge (a Stefany precisa ver de relance
 * quais normas foram confirmadas) e severidade→cor (destaque de risco).
 */

describe('badgeStatusVerificado — makes norm confirmation visible', () => {
  it('vigente → green check', () => {
    const b = badgeStatusVerificado('vigente');
    expect(b.simbolo).toBe('✓');
    expect(b.tom).toBe('ok');
    expect(b.rotulo).toMatch(/vigente/i);
  });

  it('revogada → red x', () => {
    const b = badgeStatusVerificado('revogada');
    expect(b.simbolo).toBe('✗');
    expect(b.tom).toBe('perigo');
  });

  it('contestada → ⚠ alert', () => {
    expect(badgeStatusVerificado('contestada').simbolo).toBe('⚠');
    expect(badgeStatusVerificado('contestada').tom).toBe('alerta');
  });

  it('inexistente → ⚠ alert', () => {
    expect(badgeStatusVerificado('inexistente').simbolo).toBe('⚠');
    expect(badgeStatusVerificado('inexistente').tom).toBe('alerta');
  });

  it('nao-verificado → ⚠ neutral/alert (not confirmed)', () => {
    const b = badgeStatusVerificado('nao-verificado');
    expect(b.simbolo).toBe('⚠');
    expect(b.rotulo).toMatch(/não.?verificad/i);
  });
});

describe('corSeveridade — risk highlight', () => {
  it('alta = red', () => {
    expect(corSeveridade('alta').tom).toBe('perigo');
  });
  it('media = amber/alert', () => {
    expect(corSeveridade('media').tom).toBe('alerta');
  });
  it('baixa = neutral', () => {
    expect(corSeveridade('baixa').tom).toBe('neutro');
  });
});

describe('value formatters', () => {
  it('fmtMoedaBRL formats a number in BRL', () => {
    expect(fmtMoedaBRL(1234.5)).toMatch(/1\.234,50/);
  });
  it('fmtMoedaBRL null → em-dash', () => {
    expect(fmtMoedaBRL(null)).toBe('—');
  });
  it('fmtMeses', () => {
    expect(fmtMeses(12)).toBe('12 meses');
    expect(fmtMeses(null)).toBe('—');
  });
  it('fmtDias', () => {
    expect(fmtDias(3)).toBe('3 dias');
    expect(fmtDias(null)).toBe('—');
  });
});
