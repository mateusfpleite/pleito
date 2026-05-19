/**
 * Runner do Gate Tier 0 (SPEC §11a) — `pnpm eval:tier0`.
 *
 * Carrega o corpus de regressão versionado (`fixtures/gold/*.json`). Esses
 * arquivos são EXTRAÇÕES cruas do POC (sem ofício, `statusVerificado` no
 * default `nao-verificado` após o parse do schema). Para o gate de fixtures:
 *
 *   - roda `checarContencao` com `oficio:null` (não deve haver violação
 *     trivial — sem ofício, só a checagem de baseline-consistência roda).
 *
 * HONESTIDADE (resíduo de cobertura, agora fechado): no corpus gold do POC
 * TODAS as leis ficam `statusVerificado='nao-verificado'` na reconstrução
 * (o POC não passou pelo Norma Verifier). A checagem 3
 * (`baseline-divergente`) IGNORA `nao-verificado` por design — logo ela é
 * INERTE no corpus gold. Sem mais nada, o gold validaria apenas as
 * checagens 1/2/4 + parse de schema, NÃO a consistência baseline.
 *
 * Para EXERCITAR de fato a checagem 3, há a fixture sintética versionada
 * `synthetic-verificado.json`: ≥1 lei com `statusVerificado` POPULADO e
 * DIVERGENTE da baseline curada (8666/1993 = `revogada-notoria` → esperado
 * `revogada`, fixada como `vigente`). O runner a trata em modo AUTO-TESTE:
 * ela DEVE produzir a violação `baseline-divergente` esperada; se NÃO
 * produzir, a própria checagem 3 está quebrada → gate falha. Assim a
 * ausência de violação no resto do gold é prova real (a checagem funciona,
 * só não dispara onde não deve), não cobertura morta.
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
import { normalizarGold } from './normalizar-gold.ts';

const GOLD_DIR = fileURLToPath(new URL('../fixtures/gold', import.meta.url));

function main(): void {
  const arquivos = readdirSync(GOLD_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  // Fixtures de AUTO-TESTE: NÃO são corpus "0 violações". Devem produzir uma
  // violação ESPERADA — exercitam de fato a checagem indicada (senão a
  // própria checagem está quebrada → gate falha). Ver header (honestidade).
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

    const esperada = AUTO_TESTE[nome];
    if (esperada) {
      // Modo auto-teste: a violação esperada DEVE estar presente.
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
      continue; // fixture de auto-teste não conta no corpus "0 violações".
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
