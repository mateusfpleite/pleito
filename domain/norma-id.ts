/**
 * Normalização canônica do número de uma norma.
 *
 * Implementação EXATA e VALIDADA do `src/spike-matcher.ts` — não reinventar.
 * O spike provou empiricamente (corpus real de 99 leis, 37 que devem casar):
 * aplicar esta normalização nos DOIS lados (número cru do extractor E número
 * da baseline) derruba o falso-negativo de 23/37 para 0/37.
 *
 * Regras (na ordem):
 *   1. null/undefined → '' (extractor emite `numero:null` p.ex. Constituição).
 *   2. usa só o trecho antes da primeira '/' ("8.666/93" → "8.666").
 *   3. remove tudo que não é dígito ("nº 8.666" → "8666").
 *   4. remove zeros à esquerda ("05" → "5").
 *   5. se o resultado ficou vazio mas havia dígitos (só zeros), mantém os
 *      dígitos para não perder "0" / "00".
 *
 * `domain/` é zero-dependência: função pura, sem I/O.
 */
export function normalizarNumero(s: string): string {
  if (s == null) return '';
  const antesBarra = String(s).split('/')[0];
  const digitos = antesBarra.replace(/\D/g, '');
  const semZeros = digitos.replace(/^0+/, '');
  return semZeros.length ? semZeros : digitos;
}
