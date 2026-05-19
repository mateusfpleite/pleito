/**
 * Reconstruction of the POC gold corpus (pre schema v3) into the complete
 * `EditalExtraction` — SINGLE source, shared by the Tier 0 Gate runner
 * (`run-tier0.ts`) and the E2E suite (`tests/e2e/corpus.test.ts`).
 *
 * The files `fixtures/gold/{dombasilio,jaborandi,niteroi}.json` are raw POC
 * EXTRACTIONS: they carry neither `pontosDeAtencao` (a Risk Analyst field),
 * nor the v3 fields (`plataforma`, `subcontratacaoPermitida`,
 * `intervaloMinimoLances`, `prazoRecursosDiasUteis`,
 * `informacoesViabilidade`), nor per-lei `fonteVerificacao`. The object is
 * reconstructed the SAME way `application/` does (recompose):
 * `pontosDeAtencao: []` (placeholder; it belongs to the Risk Analyst),
 * absent v3 fields → null (`.nullable()` in the schema), absent
 * `fonteVerificacao` → null. An absent `statusVerificado` is supplied by
 * the schema's `.default('nao-verificado')`.
 *
 * Centralizing here guarantees that E2E validates EXACTLY the same
 * reconstruction invariant as the production gate — with no divergeable
 * copy.
 */

/**
 * A non-object / one without `leisReferenciadas` (e.g.
 * `baserate-result.json`) passes through → the caller's `safeParse` fails →
 * fixture ignored (it is not an edital extraction).
 */
export function normalizarGold(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  const leis = obj.leisReferenciadas;
  if (!Array.isArray(leis)) return raw;
  const v3Nullable = [
    'plataforma',
    'subcontratacaoPermitida',
    'intervaloMinimoLances',
    'prazoRecursosDiasUteis',
    'informacoesViabilidade',
  ] as const;
  const v3Defaults: Record<string, null> = {};
  for (const k of v3Nullable) {
    if (obj[k] === undefined) v3Defaults[k] = null;
  }
  return {
    ...obj,
    ...v3Defaults,
    pontosDeAtencao: Array.isArray(obj.pontosDeAtencao)
      ? obj.pontosDeAtencao
      : [],
    leisReferenciadas: leis.map((l) => {
      const lei = l as Record<string, unknown>;
      return {
        ...lei,
        fonteVerificacao:
          lei.fonteVerificacao === undefined ? null : lei.fonteVerificacao,
      };
    }),
  };
}
