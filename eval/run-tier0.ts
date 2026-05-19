/**
 * Runner do Gate Tier 0 (SPEC §11a) — `pnpm eval:tier0`.
 *
 * Carrega o corpus de regressão versionado (`fixtures/gold/*.json`). Esses
 * arquivos são EXTRAÇÕES cruas do POC (sem ofício, `statusVerificado` no
 * default `nao-verificado` após o parse do schema). Para o gate de fixtures:
 *
 *   - roda `checarContencao` com `oficio:null` (não deve haver violação
 *     trivial — sem ofício, só a checagem de baseline-consistência roda);
 *   - a checagem 3 (baseline) valida cada extração gold mesmo sem ofício
 *     (pega divergência de status verificado vs baseline curado).
 *
 * Arquivos que NÃO são extração de edital (ex.: `baserate-result.json` —
 * saída do spike-matcher) são ignorados via parse seguro do schema.
 *
 * NORMALIZAÇÃO: os gold são do POC (pré schema v3) — não trazem
 * `pontosDeAtencao`, `statusVerificado` nem `fonteVerificacao`. Reconstrói-se
 * o `EditalExtraction` completo do MESMO modo que o `application/`:
 * `pontosDeAtencao: []` (placeholder; é do Risk Analyst) e, por lei,
 * `fonteVerificacao: null` ausente → null. `statusVerificado` ausente já é
 * suprido pelo `.default('nao-verificado')` do schema (não verificado ≠
 * divergência — a checagem baseline o ignora).
 *
 * Sai com código ≠0 se QUALQUER violação for encontrada (gate duro).
 * Determinístico, sem LLM, sem rede.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EditalExtractionSchema } from '../domain/schema.ts';
import { checarContencao, type Violacao } from './tier0.ts';

const GOLD_DIR = fileURLToPath(new URL('../fixtures/gold', import.meta.url));

/**
 * Reconstrói o `EditalExtraction` completo a partir do gold cru (POC) do
 * MESMO modo que o `application/`: `pontosDeAtencao: []` (é do Risk Analyst,
 * não do Extractor) e `fonteVerificacao: null` quando ausente por lei.
 * `statusVerificado` ausente é suprido pelo default do schema. Não-objeto /
 * sem `leisReferenciadas` (ex.: baserate) passa direto → safeParse falha →
 * ignorado.
 */
function normalizarGold(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  const leis = obj.leisReferenciadas;
  if (!Array.isArray(leis)) return raw;
  // Campos v3 (SPEC §6) ausentes no POC pré-v3: todos `.nullable()` no
  // schema → null quando o gold não os trazia.
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

function main(): void {
  const arquivos = readdirSync(GOLD_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  let totalViolacoes = 0;
  let extracoesValidadas = 0;
  const ignorados: string[] = [];

  for (const nome of arquivos) {
    const raw = JSON.parse(
      readFileSync(`${GOLD_DIR}/${nome}`, 'utf-8')
    ) as unknown;

    // Parse seguro: arquivos que não são extração de edital (baserate) são
    // ignorados — não são corpus de regressão do Tier 0.
    const parsed = EditalExtractionSchema.safeParse(normalizarGold(raw));
    if (!parsed.success) {
      ignorados.push(nome);
      continue;
    }

    const extracao = parsed.data;
    const { violacoes } = checarContencao({ extracao, oficio: null });
    extracoesValidadas += 1;

    if (violacoes.length > 0) {
      totalViolacoes += violacoes.length;
      console.error(`\n✗ ${nome} — ${violacoes.length} violação(ões):`);
      for (const v of violacoes) {
        console.error(`   [${v.tipo}] ${v.detalhe}`);
      }
    } else {
      console.log(`✓ ${nome} — 0 violações`);
    }
  }

  if (ignorados.length > 0) {
    console.log(
      `\nℹ ignorados (não são extração de edital): ${ignorados.join(', ')}`
    );
  }

  console.log(
    `\nTier 0: ${extracoesValidadas} extração(ões) gold validada(s), ` +
      `${totalViolacoes} violação(ões) no total.`
  );

  if (totalViolacoes > 0) {
    console.error('\nGATE TIER 0 FALHOU — build bloqueado (SPEC §11a).');
    process.exit(1);
  }

  console.log('GATE TIER 0 OK — 0 violações.');
}

main();

export type { Violacao };
