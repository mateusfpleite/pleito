/**
 * Canonical normalization of a norma's number.
 *
 * EXACT and VALIDATED implementation from `src/spike-matcher.ts` — do not
 * reinvent. The spike proved empirically (real corpus of 99 laws, 37 that
 * must match): applying this normalization on BOTH sides (raw number from
 * the extractor AND baseline number) drops the false-negative from 23/37
 * to 0/37.
 *
 * Rules (in order):
 *   1. null/undefined → '' (extractor emits `numero:null`, e.g. Constituição).
 *   2. uses only the segment before the first '/' ("8.666/93" → "8.666").
 *   3. strips everything that is not a digit ("nº 8.666" → "8666").
 *   4. strips leading zeros ("05" → "5").
 *   5. if the result became empty but there were digits (only zeros), keeps
 *      the digits so as not to lose "0" / "00".
 *
 * `domain/` is zero-dependency: pure function, no I/O.
 */
export function normalizarNumero(s: string): string {
  if (s == null) return '';
  const antesBarra = String(s).split('/')[0];
  const digitos = antesBarra.replace(/\D/g, '');
  const semZeros = digitos.replace(/^0+/, '');
  return semZeros.length ? semZeros : digitos;
}
