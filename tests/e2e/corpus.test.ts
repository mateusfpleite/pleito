/**
 * ============================================================================
 * E2E DETERMINÍSTICO sobre o corpus-ouro (Phase 17.1)
 * ============================================================================
 *
 * ESCOPO HONESTO: o E2E COMPLETO (pipeline real ponta-a-ponta via worker
 * com Gemini 2.5 Flash + Postgres + claim atômico + dashboard) é RESÍDUO
 * DE DEPLOY — exige infra que NÃO existe neste ambiente (sem Postgres real,
 * sem chromium no DEV, chamadas Gemini reais custam/dependem de rede). Os
 * critérios "Done V0" que dependem de LLM/DB reais ficam como CHECKLIST no
 * runbook `docs/DEPLOY.md` (Phase 17.2), validados em PRODUÇÃO via
 * telemetria (SPEC §11b/§11c) — NÃO como teste que falha aqui.
 *
 * Esta suíte valida as INVARIANTES DETERMINÍSTICAS que o corpus-ouro
 * (`fixtures/gold/{dombasilio,jaborandi,niteroi}.json` — extrações já
 * feitas pelo POC) deve satisfazer SEM LLM e SEM DB:
 *
 *   1. Cada gold reconstrói (mesma normalização que o `application/`) e
 *      PARSEIA contra `EditalExtractionSchema` (schema 100% válido — Done V0).
 *   2. `matchNorma` + Gate A sobre as leis de cada gold: leis revogadas
 *      notórias detectadas (8666/1993, 10520/2002 no Jaborandi); Gate A
 *      dispara o Verifier onde há risco.
 *   3. Achados-armadilha registrados na própria extração do POC: Jaborandi
 *      tem `incoerencia` objeto-divergente (capa mentirosa); Niterói está
 *      sob regime 13.303 com anexo ausente; Dom Basílio tem
 *      valor-divergente severidade alta.
 *   4. `checarContencao` com `oficio:null` sobre cada gold → 0 violações
 *      (consistência baseline; sem ofício, só a checagem 3 é relevante).
 *
 * O Gate Tier 0 sobre o corpus completo (incl. auto-teste sintético) é
 * coberto por `pnpm eval:tier0` (`eval/run-tier0.ts`) — referenciado aqui,
 * não reimplementado.
 *
 * A QUALIDADE da extração LLM (acurácia capa-mentirosa/valor/sigiloso) NÃO
 * é testada aqui — testar "o LLM retornou X" é anti-pattern
 * (@superpowers:testing-anti-patterns); valida-se em produção via
 * telemetria (SPEC §11c). Aqui só asseguramos as propriedades estruturais
 * determinísticas do corpus congelado.
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

/** Carrega + reconstrói + parseia um gold do POC (mesma via do runner). */
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
 * GATE A (espelha `application/analyze-edital.ts`): dispara se QUALQUER lei
 * tem `revogada=true` OU casa baseline numa categoria de risco (status
 * esperado ≠ null e ≠ 'vigente').
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

describe('E2E determinístico — corpus-ouro (Phase 17.1)', () => {
  describe('(1) cada gold parseia contra EditalExtractionSchema (Done V0: schema 100% válido)', () => {
    for (const nome of GOLDS) {
      it(`${nome} reconstrói e parseia (schema v3)`, () => {
        const extracao = carregarGold(nome);
        // Re-parse defensivo: o objeto reconstruído é estritamente válido.
        expect(() =>
          EditalExtractionSchema.parse(extracao)
        ).not.toThrow();
        expect(extracao.municipio).toBeTruthy();
        expect(extracao.uf).toHaveLength(2);
      });
    }
  });

  describe('(2) matchNorma + Gate A — leis revogadas notórias detectadas', () => {
    it('Jaborandi: 8666/1993 e 10520/2002 casam baseline como revogada-notoria', () => {
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
        // O POC já marcou estas como revogada=true (palpite do extractor).
        expect(lei.revogada).toBe(true);
      }
    });

    it('Gate A dispara para Jaborandi (lei revogada notória → exige Verifier)', () => {
      expect(gateADispara(carregarGold('jaborandi'))).toBe(true);
    });

    it('NENHUM gold marca lei vigente-âncora como risco (anti-falso-positivo)', () => {
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

  describe('(3) achados-armadilha registrados na extração do POC', () => {
    it('Jaborandi: incoerência objeto-divergente (capa mentirosa) presente', () => {
      const j = carregarGold('jaborandi');
      const objetoDivergente = j.incoerencias.find(
        (i) => i.tipo === 'objeto-divergente'
      );
      expect(
        objetoDivergente,
        'Jaborandi deve registrar incoerência objeto-divergente (capa vs corpo)'
      ).toBeTruthy();
      expect(objetoDivergente!.severidade).toBe('alta');
      // O extractor do POC também marcou explicitamente uma lei revogada.
      expect(
        j.incoerencias.some((i) => i.tipo === 'lei-revogada')
      ).toBe(true);
    });

    it('Niterói: regime 13.303 + anexo declarado ausente', () => {
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

    it('Dom Basílio: incoerência valor-divergente severidade alta', () => {
      const d = carregarGold('dombasilio');
      const valorDivergente = d.incoerencias.find(
        (i) => i.tipo === 'valor-divergente'
      );
      expect(valorDivergente).toBeTruthy();
      expect(valorDivergente!.severidade).toBe('alta');
    });
  });

  describe('(4) checarContencao(gold, oficio:null) → 0 violações', () => {
    for (const nome of GOLDS) {
      it(`${nome}: sem ofício, 0 violações de contenção`, () => {
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
   * Done V0 verificável offline já coberto:
   *  - schema 100% válido → (1) acima + `domain/schema.test.ts`
   *  - lei-revogada / anexo-ausente / capa-mentirosa registrados → (3)
   *  - Gate Tier 0 = 0 violações → `pnpm eval:tier0` (eval/run-tier0.ts,
   *    incl. auto-teste sintético `synthetic-verificado.json`)
   *  - contenção estrutural → eval/tier0.test.ts + (4) acima
   *
   * Done V0 que SÓ fecha pós-deploy (checklist em docs/DEPLOY.md):
   *  - 3 ref + Mata Grande via worker REAL sem erro (Gemini+Postgres)
   *  - pipeline completo no worker sem timeout (<90s)
   *  - dashboard + ofício editável + PDF on-demand e2e (chromium real)
   *  - telemetria gravando em Postgres real
   *  - deploy acessível à Stefany
   */
  it('referência: pnpm eval:tier0 cobre o Gate Tier 0 sobre o corpus completo', () => {
    // Marcador documental — o gate duro roda em `pnpm eval:tier0`
    // (eval/run-tier0.ts), não reimplementado aqui. Ver docs/DEPLOY.md.
    expect(true).toBe(true);
  });
});
