import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { matchNorma } from './norma-baseline.ts';
import { normalizarNumero } from './norma-id.ts';

/**
 * Matcher do baseline — núcleo do moat de segurança.
 *
 * Design TRAVADO pelo spike (`src/spike-matcher.ts`): falso-negativo 0/37 com
 * normalização nos 2 lados + fallback tolerante; 23/37 sem. NÃO reinventar.
 *
 * Os inputs usam o formato REAL do extractor (`output/*.json`): `numero` é
 * só-dígitos ("8666", não "8.666"); `ano` numérico; `escopo`/`tipoNorma` em
 * minúsculas. Testar a lógica determinística com dados reais — sem mock de
 * LLM (não há LLM nesta phase).
 */

// Baseline real em disco — não mockar; é dado curado versionado.
const baseline = JSON.parse(
  readFileSync(resolve('data/norma-baseline.json'), 'utf-8')
) as { entries: Array<Record<string, unknown>> };

describe('matchNorma — canonical cases (REAL extractor input)', () => {
  it('(a) 8666/1993 federal lei → revogada-notoria (from jaborandi.json)', () => {
    // Extraído literalmente de output/jaborandi.json:
    // {"numero":"8666","ano":1993,"escopo":"federal","tipoNorma":"lei"}
    const r = matchNorma({
      numero: '8666',
      ano: 1993,
      escopo: 'federal',
      tipoNorma: 'lei',
    });
    expect(r).not.toBeNull();
    expect(r!.entry.id).toBe('lei-8666-1993');
    expect(r!.categoria).toBe('revogada-notoria');
    expect(r!.status).toBe('revogada');
    expect(r!.via).toBe('estrito');
  });

  it('(b) IN 5/2017 federal instrucao-normativa → zona-cinzenta', () => {
    const r = matchNorma({
      numero: '5',
      ano: 2017,
      escopo: 'federal',
      tipoNorma: 'instrucao-normativa',
    });
    expect(r).not.toBeNull();
    expect(r!.entry.id).toBe('in-seges-05-2017');
    expect(r!.categoria).toBe('zona-cinzenta');
    expect(r!.status).toBe('vigente');
    expect(r!.via).toBe('estrito');
  });

  it('(c) 9704/1995 → citacao-suspeita + status inexistente', () => {
    const r = matchNorma({
      numero: '9704',
      ano: 1995,
      escopo: 'federal',
      tipoNorma: 'lei',
    });
    expect(r).not.toBeNull();
    expect(r!.entry.id).toBe('lei-9704-licitacao-inexistente');
    expect(r!.categoria).toBe('citacao-suspeita');
    expect(r!.status).toBe('inexistente');
  });

  it('(d) norm outside the table → null', () => {
    // Lei 13.303/2016 NÃO está na baseline (é regime-jurídico válido,
    // não precisa de verificação) — input real de niteroi.json.
    const r = matchNorma({
      numero: '13303',
      ano: 2016,
      escopo: 'federal',
      tipoNorma: 'lei',
    });
    expect(r).toBeNull();
  });
});

describe('matchNorma — tolerant fallback (extractor gets escopo/tipo wrong ~54%)', () => {
  it('(e) known revoked law with tipoNorma wrong by the LLM still matches via fallback', () => {
    // O LLM classificou a 8.666 como "decreto" (erro real de tipo).
    // Sem o fallback tolerante isto seria falso-negativo do Gate A.
    const r = matchNorma({
      numero: '8666',
      ano: 1993,
      escopo: 'estadual', // escopo também errado
      tipoNorma: 'decreto', // tipo errado
    });
    expect(r).not.toBeNull();
    expect(r!.entry.id).toBe('lei-8666-1993');
    expect(r!.categoria).toBe('revogada-notoria');
    expect(r!.via).toBe('tolerante');
  });

  it('tolerant fallback normalizes both sides (extractor "8666" vs baseline "8.666")', () => {
    // numero+ano batem só porque normalizarNumero roda nos DOIS lados.
    const r = matchNorma({
      numero: '10520',
      ano: 2002,
      escopo: 'errado',
      tipoNorma: undefined,
    });
    expect(r).not.toBeNull();
    expect(r!.entry.id).toBe('lei-10520-2002');
    expect(r!.via).toBe('tolerante');
  });
});

describe('matchNorma — FALSE-NEGATIVE non-regression (bug caught in plan-review)', () => {
  it('(f) the buggy approach (without normalizing both sides) WOULD FAIL on this real input', () => {
    // Simula exatamente o approach que o plano mascarava: comparar o numero
    // cru do extractor ("8666") contra o numero cru da baseline ("8.666")
    // sem normalizar nenhum lado. O spike provou: 23/37 falsos-negativos.
    const input = { numero: '8666', ano: 1993, escopo: 'federal' };
    const matchBugado = baseline.entries.some(
      (e) =>
        (e.match as Record<string, unknown>).numero === input.numero &&
        (e.match as Record<string, unknown>).ano === input.ano
    );
    // Documenta o bug: o match cru NÃO acha ("8666" !== "8.666").
    expect(matchBugado).toBe(false);

    // O matcher correto (normaliza os 2 lados) acha — regressão fechada.
    const r = matchNorma({ ...input, tipoNorma: 'lei' });
    expect(r).not.toBeNull();
    expect(r!.entry.id).toBe('lei-8666-1993');
  });
});

describe('matchNorma — FALSE-POSITIVE non-regression', () => {
  it('(g1) alias does not match a divergent short number', () => {
    // "147" (LC 147/2014) tem alias "LC 147/2014". Um número curto
    // diferente ("14", ano divergente) NÃO pode casar via alias só porque
    // a substring "14" aparece no alias.
    const r = matchNorma({
      numero: '14',
      ano: 1999,
      escopo: 'federal',
      tipoNorma: 'lei',
    });
    expect(r).toBeNull();
  });

  it('(g1b) alias path requires nIn.length >= 3 (does not match a 2-digit number)', () => {
    // "98" não pode casar nenhuma entry via alias mesmo se a substring "98"
    // existir nos dígitos de algum alias — guarda do over-match do spike.
    const r = matchNorma({
      numero: '98',
      ano: 3000,
      escopo: 'federal',
      tipoNorma: 'lei',
    });
    expect(r).toBeNull();
  });

  it('(g2) tolerant does NOT cross escopo for an entry that is not citacao-suspeita', () => {
    // Quando há divergência de escopo e a entry casada não é
    // citacao-suspeita, o resultado NÃO deve afirmar via 'estrito'
    // (escopo não bateu) — só via 'tolerante', e a categoria continua
    // sendo a da norma real (vigente-ancora), não escala para suspeita.
    const r = matchNorma({
      numero: '8987', // Lei de Concessões — vigente-ancora, escopo federal
      ano: 1995,
      escopo: 'municipal', // escopo divergente
      tipoNorma: 'lei',
    });
    expect(r).not.toBeNull();
    expect(r!.via).toBe('tolerante'); // não 'estrito'
    expect(r!.entry.id).toBe('lei-8987-1995');
    expect(r!.categoria).toBe('vigente-ancora'); // não vira citacao-suspeita
  });

  it('(g4-I1) numero "666" does NOT match lei-8666-1993 via alias (substring of "8666")', () => {
    // BUG ESTRUTURAL DO MOAT: o path de alias usava
    // aliasDigits.includes(nIn). "666" é substring de "8666" (dígitos do
    // alias "Lei 8.666/93") → falso-positivo que FLIPA vigente→revogada
    // para um input fora do corpus. Pior modo de falha do moat.
    const r = matchNorma({
      numero: '666',
      ano: 2020,
      escopo: 'federal',
      tipoNorma: 'lei',
    });
    expect(r).toBeNull();
  });

  it('(g5-I1) numero "520" does NOT match lei-10520-2002 via alias (substring of "10520")', () => {
    const r = matchNorma({
      numero: '520',
      ano: 2099,
      escopo: 'federal',
      tipoNorma: 'lei',
    });
    expect(r).toBeNull();
  });

  it('(g6-I1) numero "462" does NOT match dec-11462-2023 via alias (substring of "11462")', () => {
    const r = matchNorma({
      numero: '462',
      ano: 2099,
      escopo: 'federal',
      tipoNorma: 'decreto',
    });
    expect(r).toBeNull();
  });

  it('(g7-I1) positive regression: a number that ONLY appears in an alias still matches via alias', () => {
    // Nenhuma entry do corpus tem numero divergente do alias (alias=0 no
    // spike), então construímos o cenário sintético: a entry lei-8666-1993
    // tem alias "Lei 8.666/93" cujo token "93" é o ANO em 2 dígitos. Um
    // input com numero exatamente igual a um TOKEN do alias (não substring
    // da concatenação) e numero+ano que NÃO casam pelas regras 1/2 deve
    // ainda assim casar via alias — preserva o comportamento correto.
    // Token exato "8666" do alias "Lei 8.666/93", com ano divergente
    // (não casa estrito nem tolerante) → casa via alias.
    const r = matchNorma({
      numero: '8666',
      ano: 1900, // ano divergente: não casa estrito/tolerante
      escopo: 'federal',
      tipoNorma: 'lei',
    });
    expect(r).not.toBeNull();
    expect(r!.entry.id).toBe('lei-8666-1993');
    expect(r!.via).toBe('alias');
  });

  it('(g3) match always has numero/ano consistent with the entry (parity w/ spike: fpAlias=0)', () => {
    // Invariante do spike: todo match resolvido tem numero+ano batendo a
    // entry casada (fpAlias=0). Varre a baseline com ANO divergente: ou
    // não casa, ou — se casar via alias — o numero/ano da entry casada
    // tem de ser coerente com o input (nunca um match com numero/ano
    // totalmente alheios).
    for (const e of baseline.entries) {
      const m = e.match as { numero: string; ano: number };
      const numCerto = normalizarNumero(m.numero);
      const anoDivergente = m.ano + 100;
      const r = matchNorma({
        numero: numCerto,
        ano: anoDivergente,
        escopo: (e.match as { escopo: string }).escopo,
        tipoNorma: (e.match as { tipoNorma: string }).tipoNorma,
      });
      if (r) {
        // se casou, foi via alias (numero bate, ano não) — e o numero
        // normalizado DEVE coincidir com o do input (não over-match).
        expect(r.via).toBe('alias');
        expect(normalizarNumero(r.entry.match.numero)).toBe(numCerto);
      }
    }
  });
});
