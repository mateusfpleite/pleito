import { describe, it, expect } from 'vitest';
import { normalizarNumero } from './norma-id.ts';

/**
 * Canonical normalization of the norm number. Design VALIDATED in the
 * spike (`src/spike-matcher.ts`): applied on BOTH sides (extractor and
 * baseline), it closes the false negative 23/37 → 0/37. The cases below
 * use the REAL format the extractor produces (`output/*.json`: "14133"
 * digits-only) AND the baseline format (`data/norma-baseline.json`:
 * "8.666" with a dot).
 */
describe('normalizarNumero', () => {
  it('keeps a digits-only number from the extractor unchanged', () => {
    // REAL extractor format (output/dombasilio.json)
    expect(normalizarNumero('14133')).toBe('14133');
  });

  it('strips the thousands separator (baseline format)', () => {
    // REAL baseline format (data/norma-baseline.json)
    expect(normalizarNumero('8.666')).toBe('8666');
  });

  it('uses only the part before the slash', () => {
    expect(normalizarNumero('8.666/93')).toBe('8666');
  });

  it('strips leading zeros', () => {
    // REAL baserate format (output/baserate-result.json: "01", "05")
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
    // EXACT behavior of the validated spike: if stripping zeros zeroes
    // everything, it returns the raw digits (not '') so as not to lose
    // the "0".
    expect(normalizarNumero('0')).toBe('0');
    expect(normalizarNumero('00')).toBe('00');
  });

  it('empty string / only non-digits → empty', () => {
    expect(normalizarNumero('')).toBe('');
    expect(normalizarNumero('lei')).toBe('');
  });

  it('null/undefined → empty (extractor may emit numero:null)', () => {
    // output/dombasilio.json has leis with numero:null (Constituição)
    expect(normalizarNumero(null as unknown as string)).toBe('');
    expect(normalizarNumero(undefined as unknown as string)).toBe('');
  });
});
