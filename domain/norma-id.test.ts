import { describe, it, expect } from 'vitest';
import { normalizarNumero } from './norma-id.ts';

/**
 * Normalização canônica do número de norma. Design VALIDADO no spike
 * (`src/spike-matcher.ts`): aplicada nos DOIS lados (extractor e baseline),
 * fecha o falso-negativo 23/37 → 0/37. Os casos abaixo usam o formato REAL
 * que o extractor produz (`output/*.json`: "14133" só-dígitos) E o formato
 * da baseline (`data/norma-baseline.json`: "8.666" com ponto).
 */
describe('normalizarNumero', () => {
  it('keeps a digits-only number from the extractor unchanged', () => {
    // formato REAL do extractor (output/dombasilio.json)
    expect(normalizarNumero('14133')).toBe('14133');
  });

  it('strips the thousands separator (baseline format)', () => {
    // formato REAL da baseline (data/norma-baseline.json)
    expect(normalizarNumero('8.666')).toBe('8666');
  });

  it('uses only the part before the slash', () => {
    expect(normalizarNumero('8.666/93')).toBe('8666');
  });

  it('strips leading zeros', () => {
    // formato REAL do baserate (output/baserate-result.json: "01", "05")
    expect(normalizarNumero('05')).toBe('5');
  });

  it('number with year after slash → only the number', () => {
    expect(normalizarNumero('5/2017')).toBe('5');
  });

  it('4-digit number with a dot', () => {
    expect(normalizarNumero('1.421')).toBe('1421');
  });

  it('strips a textual prefix ("nº")', () => {
    expect(normalizarNumero('nº 8.666')).toBe('8666');
  });

  it('keeps the digits when the number is only zero (does not become an empty string)', () => {
    // comportamento EXATO do spike validado: se strip de zeros zera tudo,
    // devolve os dígitos crus (não '' ) para não perder o "0".
    expect(normalizarNumero('0')).toBe('0');
    expect(normalizarNumero('00')).toBe('00');
  });

  it('empty string / only non-digits → empty', () => {
    expect(normalizarNumero('')).toBe('');
    expect(normalizarNumero('lei')).toBe('');
  });

  it('null/undefined → empty (extractor may emit numero:null)', () => {
    // output/dombasilio.json tem leis com numero:null (Constituição)
    expect(normalizarNumero(null as unknown as string)).toBe('');
    expect(normalizarNumero(undefined as unknown as string)).toBe('');
  });
});
