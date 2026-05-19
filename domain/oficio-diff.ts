/**
 * Diff PURO ofício gerado × exportado — o SINAL-OURO de eval (SPEC §11b).
 *
 * O Drafter gera `OficioGerado.markdown`; a Stefany edita na textarea e o
 * texto QUE ELA EXPORTOU é persistido (`oficioExportado`, Phase 14). O
 * delta entre os dois é um rótulo direto, não-supervisionado, de
 * erro/lacuna do Drafter: cada edição dela é "o Drafter errou aqui".
 *
 * Métrica determinística, sem dependência (linha-a-linha): linhas
 * adicionadas/removidas via LCS de linhas + distância de Levenshtein
 * (caractere) como magnitude contínua da mudança. Zero LLM, zero rede —
 * testável e estável (testing-anti-patterns: prova-se o cálculo, não um
 * modelo).
 *
 * FALLBACK DE SINAL VAZIO (§11b): se `gerado === exportado` (ela aceitou
 * sem editar) ou não houve export, `foiEditado=false` e o sinal-ouro é
 * NULO — o caller cai no sinal de reserva (export-sim/não + 👍/👎). Esta
 * função só REPORTA que o sinal-ouro é nulo; quem decide o fallback é o
 * `application/sinal-oficio.ts`.
 */

export type OficioDiff = {
  /** Houve edição humana? `false` ⇒ sinal-ouro NULO (cai no reserva). */
  foiEditado: boolean;
  /** Linhas presentes no exportado e ausentes no gerado. */
  linhasAdicionadas: number;
  /** Linhas presentes no gerado e ausentes no exportado. */
  linhasRemovidas: number;
  /** Distância de edição (caracteres) — magnitude contínua da mudança. */
  distanciaCaracteres: number;
  /** Tamanho (chars) do gerado e do exportado — contexto p/ a magnitude. */
  tamanhoGerado: number;
  tamanhoExportado: number;
};

/** Distância de Levenshtein (iterativa, O(n·m) memória O(min)). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Garante a linha menor como `a` (memória O(min(len))).
  if (a.length > b.length) [a, b] = [b, a];
  let prev = Array.from({ length: a.length + 1 }, (_, i) => i);
  let cur = new Array<number>(a.length + 1);
  for (let j = 1; j <= b.length; j += 1) {
    cur[0] = j;
    for (let i = 1; i <= a.length; i += 1) {
      const custo = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[i] = Math.min(
        prev[i] + 1, // remoção
        cur[i - 1] + 1, // inserção
        prev[i - 1] + custo // substituição
      );
    }
    [prev, cur] = [cur, prev];
  }
  return prev[a.length];
}

/** Comprimento da LCS de DUAS listas de linhas (programação dinâmica). */
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
 * Calcula o diff gerado × exportado. `exportado === null` (não exportou)
 * é tratado como sinal-ouro nulo SEM edição (igual a "aceitou sem editar":
 * o caller decide o fallback). Quebra por `\n`; normaliza CRLF.
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
