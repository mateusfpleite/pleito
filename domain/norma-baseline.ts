/**
 * Matcher do baseline curado (`data/norma-baseline.json`) — núcleo do moat
 * de segurança (Gate A). Antecede o Norma Verifier: hit aqui = status
 * determinístico, sem web grounding.
 *
 * Design TRAVADO pelo spike (`src/spike-matcher.ts`), validado contra corpus
 * real de 99 leis: falso-negativo 0/37 com normalização nos 2 lados +
 * fallback tolerante; 23/37 com match estrito não-normalizado (o bug que o
 * plano mascarava). NÃO reinventar — esta é a lógica portada do spike.
 *
 * Precedência (ordem importa):
 *   1. estrito    — numero+ano+escopo+tipoNorma (todos batem, normalizado).
 *   2. tolerante  — numero+ano apenas; ignora escopo/tipoNorma porque o
 *                   extractor erra esses ~54% das vezes. Fecha o
 *                   falso-negativo do Gate A.
 *   3. alias      — substring dos dígitos do alias contém o numero (≥3
 *                   dígitos), guarda contra over-match curto.
 *
 * `domain/` é zero-dependência de runtime de app; lê apenas o JSON curado
 * versionado (fs nativo, sem ORM/SDK).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

// Carregado uma vez no import — dado curado versionado, não muda em runtime.
const baseline = JSON.parse(
  readFileSync(resolve('data/norma-baseline.json'), 'utf-8')
) as { entries: BaselineEntry[] };

function resultado(entry: BaselineEntry, via: MatchVia): MatchResult {
  return {
    entry,
    categoria: entry.categoria,
    status: entry.status ?? null,
    via,
  };
}

/**
 * Casa o input do extractor contra o baseline curado.
 * @returns `{entry,categoria,status,via}` no primeiro hit pela ordem de
 *          precedência, ou `null` se nenhuma regra casar (cauda → verifier).
 */
export function matchNorma(input: NormaInput): MatchResult | null {
  const nIn = normalizarNumero(input.numero as string);
  if (!nIn) return null; // numero:null (ex.: Constituição) não casa baseline.

  // 1. ESTRITO — todos os campos batem (normalizado nos 2 lados).
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

  // 2. TOLERANTE — só numero+ano (escopo/tipoNorma do extractor são soft).
  for (const e of baseline.entries) {
    if (normalizarNumero(e.match.numero) === nIn && e.match.ano === input.ano) {
      return resultado(e, 'tolerante');
    }
  }

  // 3. ALIAS — dígitos do alias contêm o numero (≥3 dígitos: anti over-match).
  for (const e of baseline.entries) {
    for (const a of e.match.aliases ?? []) {
      if (a.replace(/\D/g, '').includes(nIn) && nIn.length >= 3) {
        return resultado(e, 'alias');
      }
    }
  }

  return null;
}
