/**
 * SINGLE CANONICAL map `curated baseline category → statusVerificado`.
 *
 * This is a SAFETY mapping (it decides whether a norma can be asserted
 * revoked in the external ofício). Duplicating it was a risk: two copies
 * could diverge silently. This export is the SINGLE source of truth —
 * `adapters/verifier/gemini.ts` and `eval/tier0.ts` import from here.
 *
 * New/unknown category → `null`: the caller decides the fallback
 * (`nao-verificado` in the Verifier; "no deterministic expectation" in Tier 0).
 */
import type { NormaStatus } from './ports.ts';

/** statusVerificado expected per curated category, or null if unknown. */
export function categoriaParaStatus(
  categoria: string
): Exclude<NormaStatus, 'nao-verificado'> | null {
  switch (categoria) {
    case 'revogada-notoria':
    case 'revogada-confirmada':
      return 'revogada';
    case 'zona-cinzenta':
      return 'contestada';
    case 'citacao-suspeita':
      return 'inexistente';
    case 'vigente-ancora':
      return 'vigente';
    default:
      return null;
  }
}
