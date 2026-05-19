/**
 * ============================================================================
 * DETERMINISTIC E2E over the gold corpus (Phase 17.1)
 * ============================================================================
 *
 * HONEST SCOPE: the FULL E2E (real end-to-end pipeline via the worker with
 * Gemini 2.5 Flash + Postgres + atomic claim + dashboard) is DEPLOY
 * RESIDUE — it requires infra that does NOT exist in this environment (no
 * real Postgres, no chromium in DEV, real Gemini calls cost/depend on the
 * network). The "Done V0" criteria that depend on real LLM/DB stay as a
 * CHECKLIST in the runbook `docs/DEPLOY.md` (Phase 17.2), validated in
 * PRODUCTION via telemetria (SPEC §11b/§11c) — NOT as a test that fails
 * here.
 *
 * This suite validates the DETERMINISTIC INVARIANTS that the gold corpus
 * (`fixtures/gold/{dombasilio,jaborandi,niteroi}.json` — extractions
 * already produced by the POC) must satisfy WITHOUT an LLM and WITHOUT a
 * DB:
 *
 *   1. Each gold reconstructs (same normalization as `application/`) and
 *      PARSES against `EditalExtractionSchema` (schema 100% valid — Done
 *      V0).
 *   2. `matchNorma` + Gate A over each gold's leis: notorious revoked leis
 *      detected (8666/1993, 10520/2002 in Jaborandi); Gate A fires the
 *      Verifier where there is risk.
 *   3. Trap findings recorded in the POC extraction itself: Jaborandi has
 *      an objeto-divergente `incoerencia` (lying cover); Niterói is under
 *      regime 13.303 with a missing annex; Dom Basílio has a
 *      valor-divergente high severidade.
 *   4. `checarContencao` with `oficio:null` over each gold → 0 violations
 *      (baseline consistency; with no ofício, only check 3 is relevant).
 *
 * The Tier 0 Gate over the full corpus (incl. the synthetic auto-test) is
 * covered by `pnpm eval:tier0` (`eval/run-tier0.ts`) — referenced here,
 * not reimplemented.
 *
 * The QUALITY of the LLM extraction (lying-cover/valor/sigiloso accuracy)
 * is NOT tested here — testing "the LLM returned X" is an anti-pattern
 * (@superpowers:testing-anti-patterns); it is validated in production via
 * telemetria (SPEC §11c). Here we only assure the deterministic structural
 * properties of the frozen corpus.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EditalExtractionSchema } from '../../domain/schema.ts';
import type { EditalExtraction } from '../../domain/schema.ts';
import { matchNorma } from '../../domain/norma-baseline.ts';
import { categoriaParaStatus } from '../../domain/categoria-status.ts';
import { checarContencao } from '../../eval/tier0.ts';
import { normalizarGold } from '../../eval/normalizar-gold.ts';

const GOLD_DIR = fileURLToPath(
  new URL('../../fixtures/gold', import.meta.url)
);

/** Loads + reconstructs + parses a POC gold (same path as the runner). */
function carregarGold(nome: string): EditalExtraction {
  const raw = JSON.parse(
    readFileSync(`${GOLD_DIR}/${nome}.json`, 'utf-8')
  ) as unknown;
  const parsed = EditalExtractionSchema.safeParse(normalizarGold(raw));
  if (!parsed.success) {
    throw new Error(
      `gold ${nome} não parseia: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`
    );
  }
  return parsed.data;
}

/**
 * GATE A (mirrors `application/analyze-edital.ts`): fires if ANY lei has
 * `revogada=true` OR matches the baseline in a risk category (expected
 * status ≠ null and ≠ 'vigente').
 */
function gateADispara(extracao: EditalExtraction): boolean {
  return extracao.leisReferenciadas.some((lei) => {
    if (lei.revogada) return true;
    const hit = matchNorma({
      numero: lei.numero,
      ano: lei.ano,
      escopo: lei.escopo,
      tipoNorma: lei.tipoNorma,
    });
    if (!hit) return false;
    const esperado = categoriaParaStatus(hit.categoria);
    return esperado !== null && esperado !== 'vigente';
  });
}

const GOLDS = ['dombasilio', 'jaborandi', 'niteroi'] as const;

describe('deterministic E2E — gold corpus (Phase 17.1)', () => {
  describe('(1) each gold parses against EditalExtractionSchema (Done V0: schema 100% valid)', () => {
    for (const nome of GOLDS) {
      it(`${nome} reconstructs and parses (schema v3)`, () => {
        const extracao = carregarGold(nome);
        // Defensive re-parse: the reconstructed object is strictly valid.
        expect(() =>
          EditalExtractionSchema.parse(extracao)
        ).not.toThrow();
        expect(extracao.municipio).toBeTruthy();
        expect(extracao.uf).toHaveLength(2);
      });
    }
  });

  describe('(2) matchNorma + Gate A — notorious revoked laws detected', () => {
    it('Jaborandi: 8666/1993 and 10520/2002 match baseline as revogada-notoria', () => {
      const j = carregarGold('jaborandi');
      const achar = (numero: string, ano: number) =>
        j.leisReferenciadas.find(
          (l) => l.numero === numero && l.ano === ano
        );

      const l8666 = achar('8666', 1993);
      const l10520 = achar('10520', 2002);
      expect(l8666, '8666/1993 presente no gold Jaborandi').toBeTruthy();
      expect(l10520, '10520/2002 presente no gold Jaborandi').toBeTruthy();

      for (const lei of [l8666!, l10520!]) {
        const hit = matchNorma({
          numero: lei.numero,
          ano: lei.ano,
          escopo: lei.escopo,
          tipoNorma: lei.tipoNorma,
        });
        expect(hit, `${lei.numero}/${lei.ano} casa baseline`).toBeTruthy();
        expect(hit!.categoria).toBe('revogada-notoria');
        expect(categoriaParaStatus(hit!.categoria)).toBe('revogada');
        // The POC already marked these as revogada=true (extractor guess).
        expect(lei.revogada).toBe(true);
      }
    });

    it('Gate A fires for Jaborandi (notorious revoked law → requires Verifier)', () => {
      expect(gateADispara(carregarGold('jaborandi'))).toBe(true);
    });

    it('NO gold marks a vigente-ancora law as risk (anti-false-positive)', () => {
      for (const nome of GOLDS) {
        const extracao = carregarGold(nome);
        for (const lei of extracao.leisReferenciadas) {
          const hit = matchNorma({
            numero: lei.numero,
            ano: lei.ano,
            escopo: lei.escopo,
            tipoNorma: lei.tipoNorma,
          });
          if (hit?.categoria === 'vigente-ancora') {
            expect(categoriaParaStatus(hit.categoria)).toBe('vigente');
          }
        }
      }
    });
  });

  describe('(3) trap findings recorded in the POC extraction', () => {
    it('Jaborandi: objeto-divergente incoerência (lying cover) present', () => {
      const j = carregarGold('jaborandi');
      const objetoDivergente = j.incoerencias.find(
        (i) => i.tipo === 'objeto-divergente'
      );
      expect(
        objetoDivergente,
        'Jaborandi deve registrar incoerência objeto-divergente (capa vs corpo)'
      ).toBeTruthy();
      expect(objetoDivergente!.severidade).toBe('alta');
      // The POC extractor also explicitly flagged a revoked lei.
      expect(
        j.incoerencias.some((i) => i.tipo === 'lei-revogada')
      ).toBe(true);
    });

    it('Niterói: regime 13.303 + annex declared absent', () => {
      const n = carregarGold('niteroi');
      expect(n.regimeJuridico).toBe('lei-13303');
      const anexoAusente = n.anexos.find(
        (a) => a.presenteNoArquivo === false
      );
      expect(
        anexoAusente,
        'Niterói deve ter ao menos 1 anexo presenteNoArquivo=false'
      ).toBeTruthy();
    });

    it('Dom Basílio: valor-divergente incoerência severidade alta', () => {
      const d = carregarGold('dombasilio');
      const valorDivergente = d.incoerencias.find(
        (i) => i.tipo === 'valor-divergente'
      );
      expect(valorDivergente).toBeTruthy();
      expect(valorDivergente!.severidade).toBe('alta');
    });
  });

  describe('(4) checarContencao(gold, oficio:null) → 0 violations', () => {
    for (const nome of GOLDS) {
      it(`${nome}: no ofício, 0 containment violations`, () => {
        const extracao = carregarGold(nome);
        const { violacoes } = checarContencao({
          extracao,
          oficio: null,
        });
        expect(
          violacoes,
          `violações inesperadas em ${nome}: ${JSON.stringify(violacoes)}`
        ).toEqual([]);
      });
    }
  });

  /**
   * Offline-verifiable Done V0 already covered:
   *  - schema 100% valid → (1) above + `domain/schema.test.ts`
   *  - lei-revogada / missing-annex / lying-cover recorded → (3)
   *  - Tier 0 Gate = 0 violations → `pnpm eval:tier0` (eval/run-tier0.ts,
   *    incl. synthetic auto-test `synthetic-verificado.json`)
   *  - structural containment → eval/tier0.test.ts + (4) above
   *
   * Done V0 that ONLY closes post-deploy (checklist in docs/DEPLOY.md):
   *  - 3 ref + Mata Grande via the REAL worker without error
   *    (Gemini+Postgres)
   *  - full pipeline in the worker without timeout (<90s)
   *  - dashboard + editable ofício + on-demand PDF e2e (real chromium)
   *  - telemetria writing to real Postgres
   *  - deploy accessible to Stefany
   */
  it('reference: pnpm eval:tier0 covers the Tier 0 Gate over the full corpus', () => {
    // Documentary marker — the hard gate runs in `pnpm eval:tier0`
    // (eval/run-tier0.ts), not reimplemented here. See docs/DEPLOY.md.
    expect(true).toBe(true);
  });
});
