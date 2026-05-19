import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { matchNorma } from './norma-baseline.ts';
import { normalizarNumero } from './norma-id.ts';

/**
 * Baseline matcher — core of the safety moat.
 *
 * Design LOCKED by the spike (`src/spike-matcher.ts`): 0/37 false negatives
 * with normalization on both sides + tolerant fallback; 23/37 without. Do
 * NOT reinvent.
 *
 * The inputs use the REAL extractor format (`output/*.json`): `numero` is
 * digits-only ("8666", not "8.666"); `ano` numeric; `escopo`/`tipoNorma`
 * lowercase. Test the deterministic logic with real data — no LLM mock
 * (there is no LLM in this phase).
 */

// Real on-disk baseline — do not mock; it is versioned curated data.
const baseline = JSON.parse(
  readFileSync(resolve('data/norma-baseline.json'), 'utf-8')
) as { entries: Array<Record<string, unknown>> };

describe('matchNorma — canonical cases (REAL extractor input)', () => {
  it('(a) 8666/1993 federal lei → revogada-notoria (from jaborandi.json)', () => {
    // Extracted literally from output/jaborandi.json:
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
    // Lei 13.303/2016 is NOT in the baseline (it is a valid legal regime,
    // needs no verification) — real input from niteroi.json.
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
    // The LLM classified 8.666 as "decreto" (real type error).
    // Without the tolerant fallback this would be a Gate A false negative.
    const r = matchNorma({
      numero: '8666',
      ano: 1993,
      escopo: 'estadual', // escopo also wrong
      tipoNorma: 'decreto', // wrong type
    });
    expect(r).not.toBeNull();
    expect(r!.entry.id).toBe('lei-8666-1993');
    expect(r!.categoria).toBe('revogada-notoria');
    expect(r!.via).toBe('tolerante');
  });

  it('tolerant fallback normalizes both sides (extractor "8666" vs baseline "8.666")', () => {
    // numero+ano match only because normalizarNumero runs on BOTH sides.
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
    // Simulates exactly the approach the plan was masking: comparing the
    // raw extractor numero ("8666") against the raw baseline numero
    // ("8.666") without normalizing either side. The spike proved: 23/37
    // false negatives.
    const input = { numero: '8666', ano: 1993, escopo: 'federal' };
    const matchBugado = baseline.entries.some(
      (e) =>
        (e.match as Record<string, unknown>).numero === input.numero &&
        (e.match as Record<string, unknown>).ano === input.ano
    );
    // Documents the bug: the raw match does NOT find it ("8666" !== "8.666").
    expect(matchBugado).toBe(false);

    // The correct matcher (normalizes both sides) finds it — regression closed.
    const r = matchNorma({ ...input, tipoNorma: 'lei' });
    expect(r).not.toBeNull();
    expect(r!.entry.id).toBe('lei-8666-1993');
  });
});

describe('matchNorma — FALSE-POSITIVE non-regression', () => {
  it('(g1) alias does not match a divergent short number', () => {
    // "147" (LC 147/2014) has alias "LC 147/2014". A different short number
    // ("14", divergent year) MUST NOT match via alias just because the
    // substring "14" appears in the alias.
    const r = matchNorma({
      numero: '14',
      ano: 1999,
      escopo: 'federal',
      tipoNorma: 'lei',
    });
    expect(r).toBeNull();
  });

  it('(g1b) alias path requires nIn.length >= 3 (does not match a 2-digit number)', () => {
    // "98" cannot match any entry via alias even if the substring "98"
    // exists in some alias's digits — the spike's over-match guard.
    const r = matchNorma({
      numero: '98',
      ano: 3000,
      escopo: 'federal',
      tipoNorma: 'lei',
    });
    expect(r).toBeNull();
  });

  it('(g2) tolerant does NOT cross escopo for an entry that is not citacao-suspeita', () => {
    // When there is an escopo divergence and the matched entry is not
    // citacao-suspeita, the result MUST NOT assert via 'estrito' (escopo
    // did not match) — only via 'tolerante', and the category stays that
    // of the real norm (vigente-ancora), it does not escalate to suspeita.
    const r = matchNorma({
      numero: '8987', // Lei de Concessões — vigente-ancora, federal escopo
      ano: 1995,
      escopo: 'municipal', // divergent escopo
      tipoNorma: 'lei',
    });
    expect(r).not.toBeNull();
    expect(r!.via).toBe('tolerante'); // not 'estrito'
    expect(r!.entry.id).toBe('lei-8987-1995');
    expect(r!.categoria).toBe('vigente-ancora'); // does not become citacao-suspeita
  });

  it('(g4-I1) numero "666" does NOT match lei-8666-1993 via alias (substring of "8666")', () => {
    // STRUCTURAL MOAT BUG: the alias path used aliasDigits.includes(nIn).
    // "666" is a substring of "8666" (digits of the alias "Lei 8.666/93")
    // → false positive that FLIPS vigente→revogada for an input outside
    // the corpus. Worst moat failure mode.
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
    // No corpus entry has a numero divergent from the alias (alias=0 in
    // the spike), so we construct the synthetic scenario: the entry
    // lei-8666-1993 has alias "Lei 8.666/93" whose token "93" is the YEAR
    // in 2 digits. An input with numero exactly equal to an alias TOKEN
    // (not a substring of the concatenation) and numero+ano that do NOT
    // match by rules 1/2 should still match via alias — preserves the
    // correct behavior. Exact token "8666" from alias "Lei 8.666/93", with
    // a divergent year (matches neither estrito nor tolerante) → matches
    // via alias.
    const r = matchNorma({
      numero: '8666',
      ano: 1900, // divergent year: matches neither estrito/tolerante
      escopo: 'federal',
      tipoNorma: 'lei',
    });
    expect(r).not.toBeNull();
    expect(r!.entry.id).toBe('lei-8666-1993');
    expect(r!.via).toBe('alias');
  });

  it('(g3) match always has numero/ano consistent with the entry (parity w/ spike: fpAlias=0)', () => {
    // Spike invariant: every resolved match has numero+ano matching the
    // matched entry (fpAlias=0). Sweeps the baseline with a divergent
    // YEAR: it either does not match, or — if it matches via alias — the
    // matched entry's numero/ano must be consistent with the input (never
    // a match with completely unrelated numero/ano).
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
        // if it matched, it was via alias (numero matches, ano does not) —
        // and the normalized numero MUST coincide with the input's (no
        // over-match).
        expect(r.via).toBe('alias');
        expect(normalizarNumero(r.entry.match.numero)).toBe(numCerto);
      }
    }
  });
});
