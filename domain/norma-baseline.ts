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
 *   3. alias      — `numero` é IGUAL a um TOKEN de dígitos do alias (≥3
 *                   dígitos), não substring da concatenação. Cada grupo
 *                   maximal de dígitos do alias ("Lei nº 8.666/93" →
 *                   ["8666","93"] após normalizar cada grupo) é um token.
 *                   Match só se nIn === token normalizado — substring da
 *                   concatenação ("666" em "8666") era falso-positivo
 *                   estrutural do moat (flip vigente→revogada).
 *
 * `domain/` é zero-dependência de runtime de app; lê apenas o JSON curado
 * versionado (fs nativo, sem ORM/SDK).
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

// Carregado uma vez no import — dado curado versionado, não muda em runtime.
// Caminho resolvido RELATIVO AO MÓDULO (não ao CWD): worker/adapters de
// phases futuras podem rodar com CWD diferente → resolve('data/...') daria
// ENOENT silencioso. import.meta.url ancora no arquivo, não no processo.
const baseline = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../data/norma-baseline.json', import.meta.url)),
    'utf-8'
  )
) as { entries: BaselineEntry[] };

/**
 * Quebra um alias nos seus grupos maximais de dígitos e normaliza cada um.
 * "Lei nº 8.666/93" → ["8666","93"]; "IN SEGES/MP nº 05/2017" → ["5","2017"].
 * Remove o ponto separador de milhar ENTRE dígitos antes de extrair grupos,
 * para "8.666" virar um único token "8666" (não ["8","666"]). O match de
 * alias compara nIn por IGUALDADE contra esses tokens — nunca substring da
 * concatenação (origem do falso-positivo estrutural do moat).
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
 * Casa o input do extractor contra o baseline curado.
 * @returns `{entry,categoria,status,via}` no primeiro hit pela ordem de
 *          precedência, ou `null` se nenhuma regra casar (cauda → verifier).
 */
export function matchNorma(input: NormaInput): MatchResult | null {
  const numero: string | null = input.numero;
  const nIn = normalizarNumero(numero ?? '');
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

  // 3. ALIAS — nIn IGUAL a um token de dígitos do alias (≥3 dígitos: anti
  // over-match). NÃO substring da concatenação: "666" não casa "8.666".
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
