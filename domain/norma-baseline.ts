/**
 * Matcher for the curated baseline (`data/norma-baseline.json`) — core of
 * the safety moat (Gate A). Precedes the Norma Verifier: a hit here =
 * deterministic status, no web grounding.
 *
 * Design LOCKED by the spike (`src/spike-matcher.ts`), validated against a
 * real corpus of 99 laws: false-negative 0/37 with normalization on both
 * sides + tolerant fallback; 23/37 with strict non-normalized match (the
 * bug the plan was masking). DO NOT reinvent — this is the logic ported
 * from the spike.
 *
 * Precedence (order matters):
 *   1. strict    — numero+ano+escopo+tipoNorma (all match, normalized).
 *   2. tolerant  — numero+ano only; ignores escopo/tipoNorma because the
 *                  extractor gets those wrong ~54% of the time. Closes the
 *                  Gate A false-negative.
 *   3. alias     — `numero` is EQUAL to a digit TOKEN of the alias (≥3
 *                  digits), not a substring of the concatenation. Each
 *                  maximal digit group of the alias ("Lei nº 8.666/93" →
 *                  ["8666","93"] after normalizing each group) is a token.
 *                  Match only if nIn === normalized token — substring of
 *                  the concatenation ("666" in "8666") was a structural
 *                  false-positive of the moat (flip vigente→revogada).
 *
 * `domain/` is zero-dependency on app runtime; it only reads the
 * versioned curated JSON (native fs, no ORM/SDK).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizarNumero } from './norma-id.ts';

export type BaselineMatch = {
  numero: string;
  ano: number;
  escopo: string;
  tipoNorma: string;
  aliases?: string[];
};

export type BaselineEntry = {
  id: string;
  categoria: string;
  status?: string;
  match: BaselineMatch;
  descricao: string;
};

export type MatchVia = 'estrito' | 'tolerante' | 'alias';

export type MatchResult = {
  entry: BaselineEntry;
  categoria: string;
  status: string | null;
  via: MatchVia;
};

export type NormaInput = {
  numero: string | null;
  ano: number | null;
  escopo: string;
  tipoNorma?: string | null;
};

// Loaded once at import — versioned curated data, does not change at runtime.
// Path resolved RELATIVE TO THE MODULE (not the CWD): worker/adapters of
// future phases may run with a different CWD → resolve('data/...') would
// give a silent ENOENT. import.meta.url anchors to the file, not the process.
const baseline = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../data/norma-baseline.json', import.meta.url)),
    'utf-8'
  )
) as { entries: BaselineEntry[] };

/**
 * Splits an alias into its maximal digit groups and normalizes each one.
 * "Lei nº 8.666/93" → ["8666","93"]; "IN SEGES/MP nº 05/2017" → ["5","2017"].
 * Removes the thousands-separator dot BETWEEN digits before extracting
 * groups, so "8.666" becomes a single token "8666" (not ["8","666"]). The
 * alias match compares nIn by EQUALITY against these tokens — never a
 * substring of the concatenation (origin of the moat's structural
 * false-positive).
 */
function tokensDigitosAlias(alias: string): string[] {
  const semSepMilhar = alias.replace(/(\d)\.(\d)/g, '$1$2');
  const grupos = semSepMilhar.match(/\d+/g) ?? [];
  return grupos.map(normalizarNumero).filter((t) => t.length > 0);
}

function resultado(entry: BaselineEntry, via: MatchVia): MatchResult {
  return {
    entry,
    categoria: entry.categoria,
    status: entry.status ?? null,
    via,
  };
}

/**
 * Matches the extractor input against the curated baseline.
 * @returns `{entry,categoria,status,via}` on the first hit by precedence
 *          order, or `null` if no rule matches (tail → verifier).
 */
export function matchNorma(input: NormaInput): MatchResult | null {
  const numero: string | null = input.numero;
  const nIn = normalizarNumero(numero ?? '');
  if (!nIn) return null; // numero:null (e.g. Constituição) does not match baseline.

  // 1. STRICT — all fields match (normalized on both sides).
  for (const e of baseline.entries) {
    if (
      normalizarNumero(e.match.numero) === nIn &&
      e.match.ano === input.ano &&
      e.match.escopo === input.escopo &&
      (input.tipoNorma ? e.match.tipoNorma === input.tipoNorma : false)
    ) {
      return resultado(e, 'estrito');
    }
  }

  // 2. TOLERANT — numero+ano only (extractor's escopo/tipoNorma are soft).
  for (const e of baseline.entries) {
    if (normalizarNumero(e.match.numero) === nIn && e.match.ano === input.ano) {
      return resultado(e, 'tolerante');
    }
  }

  // 3. ALIAS — nIn EQUAL to a digit token of the alias (≥3 digits: anti
  // over-match). NOT a substring of the concatenation: "666" does not match "8.666".
  if (nIn.length >= 3) {
    for (const e of baseline.entries) {
      for (const a of e.match.aliases ?? []) {
        if (tokensDigitosAlias(a).includes(nIn)) {
          return resultado(e, 'alias');
        }
      }
    }
  }

  return null;
}
