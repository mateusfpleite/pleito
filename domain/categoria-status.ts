/**
 * Mapa CANÔNICO ÚNICO `categoria do baseline curado → statusVerificado`.
 *
 * É um mapeamento de SEGURANÇA (decide se uma norma pode ser afirmada
 * revogada no ofício externo). Duplicá-lo era risco: duas cópias podiam
 * divergir silenciosamente. Este export é a ÚNICA fonte da verdade —
 * `adapters/verifier/gemini.ts` e `eval/tier0.ts` importam daqui.
 *
 * Categoria nova/desconhecida → `null`: o caller decide o fallback
 * (`nao-verificado` no Verifier; "sem expectativa determinística" no Tier 0).
 */
import type { NormaStatus } from './ports.ts';

/** statusVerificado esperado por categoria curada, ou null se desconhecida. */
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
