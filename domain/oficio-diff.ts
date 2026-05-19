/**
 * PURE diff of generated × exported ofício — the GOLD SIGNAL of eval
 * (SPEC §11b).
 *
 * The Drafter generates `OficioGerado.markdown`; Stefany edits it in the
 * textarea and the text SHE EXPORTED is persisted (`oficioExportado`,
 * Phase 14). The delta between the two is a direct, unsupervised label of
 * the Drafter's error/gap: each edit she makes is "the Drafter got this
 * wrong".
 *
 * Deterministic metric, no dependency (line-by-line): added/removed lines
 * via line LCS + Levenshtein distance (character) as the continuous
 * magnitude of the change. Zero LLM, zero network — testable and stable
 * (testing-anti-patterns: prove the computation, not a model).
 *
 * EMPTY-SIGNAL FALLBACK (§11b): if `gerado === exportado` (she accepted
 * without editing) or there was no export, `foiEditado=false` and the gold
 * signal is NULL — the caller falls back to the reserve signal
 * (export-yes/no + 👍/👎). This function only REPORTS that the gold signal
 * is null; the one that decides the fallback is
 * `application/sinal-oficio.ts`.
 */

export type OficioDiff = {
  /** Was there a human edit? `false` ⇒ gold signal NULL (falls back to reserve). */
  foiEditado: boolean;
  /** Lines present in the exported and absent in the generated. */
  linhasAdicionadas: number;
  /** Lines present in the generated and absent in the exported. */
  linhasRemovidas: number;
  /** Edit distance (characters) — continuous magnitude of the change. */
  distanciaCaracteres: number;
  /** Size (chars) of the generated and the exported — context for the magnitude. */
  tamanhoGerado: number;
  tamanhoExportado: number;
};

/** Levenshtein distance (iterative, O(n·m) time, O(min) memory). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Ensure the shorter string is `a` (O(min(len)) memory).
  if (a.length > b.length) [a, b] = [b, a];
  let prev = Array.from({ length: a.length + 1 }, (_, i) => i);
  let cur = new Array<number>(a.length + 1);
  for (let j = 1; j <= b.length; j += 1) {
    cur[0] = j;
    for (let i = 1; i <= a.length; i += 1) {
      const custo = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[i] = Math.min(
        prev[i] + 1, // deletion
        cur[i - 1] + 1, // insertion
        prev[i - 1] + custo // substitution
      );
    }
    [prev, cur] = [cur, prev];
  }
  return prev[a.length];
}

/** Length of the LCS of TWO lists of lines (dynamic programming). */
function lcsLinhas(a: string[], b: string[]): number {
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(dp[j], dp[j - 1]);
      diagonal = tmp;
    }
  }
  return dp[b.length];
}

/**
 * Computes the generated × exported diff. `exportado === null` (did not
 * export) is treated as a null gold signal WITHOUT an edit (same as
 * "accepted without editing": the caller decides the fallback). Splits on
 * `\n`; normalizes CRLF.
 */
export function calcularDiffOficio(
  gerado: string,
  exportado: string | null
): OficioDiff {
  const g = gerado.replace(/\r\n/g, '\n');
  const e = (exportado ?? gerado).replace(/\r\n/g, '\n');
  const foiEditado = exportado !== null && e !== g;

  const linhasG = g.split('\n');
  const linhasE = e.split('\n');
  const comum = lcsLinhas(linhasG, linhasE);

  return {
    foiEditado,
    linhasAdicionadas: linhasE.length - comum,
    linhasRemovidas: linhasG.length - comum,
    distanciaCaracteres: foiEditado ? levenshtein(g, e) : 0,
    tamanhoGerado: g.length,
    tamanhoExportado: exportado === null ? 0 : e.length,
  };
}
