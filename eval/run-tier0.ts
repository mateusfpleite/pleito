/**
 * Tier 0 Gate runner (SPEC §11a) — `pnpm eval:tier0`.
 *
 * Loads the versioned regression corpus (`fixtures/gold/*.json`). These
 * files are raw POC EXTRACTIONS (no ofício, `statusVerificado` at its
 * `nao-verificado` default after schema parse). For the fixture gate:
 *
 *   - runs `checarContencao` with `oficio:null` (there must be no trivial
 *     violation — with no ofício, only the baseline-consistency check runs).
 *
 * HONESTY (coverage residue, now closed): in the POC gold corpus ALL leis
 * stay `statusVerificado='nao-verificado'` after reconstruction (the POC
 * never went through the Norma Verifier). Check 3 (`baseline-divergente`)
 * IGNORES `nao-verificado` by design — so it is INERT on the gold corpus.
 * With nothing else, the gold would validate only checks 1/2/4 + schema
 * parse, NOT baseline consistency.
 *
 * To actually EXERCISE check 3, there is the versioned synthetic fixture
 * `synthetic-verificado.json`: ≥1 lei with `statusVerificado` POPULATED and
 * DIVERGENT from the curated baseline (8666/1993 = `revogada-notoria` →
 * expected `revogada`, pinned as `vigente`). The runner treats it in
 * AUTO-TEST mode: it MUST produce the expected `baseline-divergente`
 * violation; if it does NOT, check 3 itself is broken → gate fails. So the
 * absence of a violation in the rest of the gold is real proof (the check
 * works, it just does not fire where it should not), not dead coverage.
 *
 * Files that are NOT an edital extraction (e.g. `baserate-result.json` —
 * spike-matcher output) are ignored via safe schema parse.
 *
 * NORMALIZATION: the gold files are from the POC (pre schema v3) — they
 * carry neither `pontosDeAtencao`, `statusVerificado` nor
 * `fonteVerificacao`. The complete `EditalExtraction` is reconstructed the
 * SAME way `application/` does: `pontosDeAtencao: []` (placeholder; it
 * belongs to the Risk Analyst) and, per lei, absent `fonteVerificacao:
 * null` → null. An absent `statusVerificado` is already supplied by the
 * schema's `.default('nao-verificado')` (not-verified ≠ divergence — the
 * baseline check ignores it).
 *
 * Exits with a non-zero code if ANY violation is found (hard gate).
 * Deterministic, no LLM, no network.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EditalExtractionSchema } from '../domain/schema.ts';
import { checarContencao, type Violacao } from './tier0.ts';
import { normalizarGold } from './normalizar-gold.ts';

const GOLD_DIR = fileURLToPath(new URL('../fixtures/gold', import.meta.url));

function main(): void {
  const arquivos = readdirSync(GOLD_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  // AUTO-TEST fixtures: NOT part of the "0 violations" corpus. They must
  // produce an EXPECTED violation — actually exercising the indicated check
  // (otherwise the check itself is broken → gate fails). See header (honesty).
  const AUTO_TESTE: Record<string, Violacao['tipo']> = {
    'synthetic-verificado.json': 'baseline-divergente',
  };

  let totalViolacoes = 0;
  let extracoesValidadas = 0;
  let autoTestesOk = 0;
  const ignorados: string[] = [];
  const autoTestesFalhos: string[] = [];

  for (const nome of arquivos) {
    const raw = JSON.parse(
      readFileSync(`${GOLD_DIR}/${nome}`, 'utf-8')
    ) as unknown;

    // Safe parse: files that are not an edital extraction (baserate) are
    // ignored — they are not part of the Tier 0 regression corpus.
    const parsed = EditalExtractionSchema.safeParse(normalizarGold(raw));
    if (!parsed.success) {
      ignorados.push(nome);
      continue;
    }

    const extracao = parsed.data;
    const { violacoes } = checarContencao({ extracao, oficio: null });
    extracoesValidadas += 1;

    const esperada = AUTO_TESTE[nome];
    if (esperada) {
      // Auto-test mode: the expected violation MUST be present.
      const pegou = violacoes.some((v) => v.tipo === esperada);
      if (pegou) {
        autoTestesOk += 1;
        console.log(
          `✓ ${nome} — auto-teste OK (violação esperada '${esperada}' ` +
            `detectada → checagem exercitada)`
        );
      } else {
        autoTestesFalhos.push(nome);
        console.error(
          `\n✗ ${nome} — AUTO-TESTE FALHOU: violação esperada ` +
            `'${esperada}' NÃO foi detectada (a checagem correspondente ` +
            `está quebrada). Violações obtidas: ` +
            `${JSON.stringify(violacoes.map((v) => v.tipo))}`
        );
      }
      continue; // an auto-test fixture does not count in the "0 violations" corpus.
    }

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
    `\nTier 0: ${extracoesValidadas} extração(ões) validada(s) ` +
      `(${autoTestesOk} auto-teste(s) OK), ` +
      `${totalViolacoes} violação(ões) inesperada(s) no corpus gold.`
  );

  if (totalViolacoes > 0 || autoTestesFalhos.length > 0) {
    if (autoTestesFalhos.length > 0) {
      console.error(
        `\nAUTO-TESTE(S) FALHO(S): ${autoTestesFalhos.join(', ')} — ` +
          `a checagem que deveriam exercitar está quebrada.`
      );
    }
    console.error('\nGATE TIER 0 FALHOU — build bloqueado (SPEC §11a).');
    process.exit(1);
  }

  console.log('GATE TIER 0 OK — 0 violações inesperadas, auto-testes verdes.');
}

main();

export type { Violacao };
