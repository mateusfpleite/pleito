/**
 * Reconstrução do corpus gold do POC (pré schema v3) para o
 * `EditalExtraction` completo — fonte ÚNICA, compartilhada pelo runner do
 * Gate Tier 0 (`run-tier0.ts`) e pela suíte E2E (`tests/e2e/corpus.test.ts`).
 *
 * Os arquivos `fixtures/gold/{dombasilio,jaborandi,niteroi}.json` são
 * EXTRAÇÕES cruas do POC: não trazem `pontosDeAtencao` (campo do Risk
 * Analyst), nem os campos v3 (`plataforma`, `subcontratacaoPermitida`,
 * `intervaloMinimoLances`, `prazoRecursosDiasUteis`,
 * `informacoesViabilidade`), nem `fonteVerificacao` por lei. Reconstrói-se
 * o objeto do MESMO modo que o `application/` (recompor): `pontosDeAtencao:
 * []` (placeholder; é do Risk Analyst), campos v3 ausentes → null
 * (`.nullable()` no schema), `fonteVerificacao` ausente → null.
 * `statusVerificado` ausente é suprido pelo `.default('nao-verificado')`
 * do schema.
 *
 * Centralizar aqui garante que o E2E valide EXATAMENTE a mesma invariante
 * de reconstrução que o gate de produção — sem cópia divergível.
 */

/**
 * Não-objeto / sem `leisReferenciadas` (ex.: `baserate-result.json`) passa
 * direto → o `safeParse` do caller falha → fixture ignorada (não é
 * extração de edital).
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
