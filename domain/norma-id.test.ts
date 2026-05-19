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
  it('mantém número só-dígitos do extractor inalterado', () => {
    // formato REAL do extractor (output/dombasilio.json)
    expect(normalizarNumero('14133')).toBe('14133');
  });

  it('strip de ponto de milhar (formato da baseline)', () => {
    // formato REAL da baseline (data/norma-baseline.json)
    expect(normalizarNumero('8.666')).toBe('8666');
  });

  it('usa apenas o trecho antes da barra', () => {
    expect(normalizarNumero('8.666/93')).toBe('8666');
  });

  it('strip de zeros à esquerda', () => {
    // formato REAL do baserate (output/baserate-result.json: "01", "05")
    expect(normalizarNumero('05')).toBe('5');
  });

  it('número com ano após barra → só o número', () => {
    expect(normalizarNumero('5/2017')).toBe('5');
  });

  it('número de 4 dígitos com ponto', () => {
    expect(normalizarNumero('1.421')).toBe('1421');
  });

  it('strip de prefixo textual ("nº")', () => {
    expect(normalizarNumero('nº 8.666')).toBe('8666');
  });

  it('mantém os dígitos quando o número é só zero (não vira string vazia)', () => {
    // comportamento EXATO do spike validado: se strip de zeros zera tudo,
    // devolve os dígitos crus (não '' ) para não perder o "0".
    expect(normalizarNumero('0')).toBe('0');
    expect(normalizarNumero('00')).toBe('00');
  });

  it('string vazia / só não-dígitos → vazio', () => {
    expect(normalizarNumero('')).toBe('');
    expect(normalizarNumero('lei')).toBe('');
  });

  it('null/undefined → vazio (extractor pode emitir numero:null)', () => {
    // output/dombasilio.json tem leis com numero:null (Constituição)
    expect(normalizarNumero(null as unknown as string)).toBe('');
    expect(normalizarNumero(undefined as unknown as string)).toBe('');
  });
});
