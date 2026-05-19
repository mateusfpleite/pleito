/**
 * Application workflow (hexagonal) — orchestrates the SPEC §4 pipeline
 * with the 2 gates (§4, §5). Zero technology dependency: receives the
 * injected ports (`AnalyzeDeps`) and composes them. Concrete adapters
 * (Gemini, Prisma) are the infrastructure's responsibility; this module
 * is unit-testable with mocks only (`analyze-edital.test.ts`).
 *
 * CONTRACT (important):
 *  - Failure of ANY adapter PROPAGATES: `analyzeEdital` rejects with the
 *    original error; the downstream pipeline does NOT run (no
 *    catch-and-continue, no partial doc). The caller (worker, Phase 12)
 *    marks the Job as `erro`.
 *  - Tier 0 (structural containment) is a FATAL ERROR: if
 *    `checarContencao` returns any violation, `analyzeEdital` THROWS —
 *    NEVER returns an ofício/analysis with a containment violation. The
 *    caller cannot catch-and-continue with a partial doc (carry-forward
 *    3rd review).
 *
 * Pipeline:
 *   preprocess → extract → [recomposition] → Gate A → verifier?
 *     → risk → Gate B → drafter? → Tier 0 (fatal) → { extracao, oficio }
 */

import {
  EditalExtractionSchema,
  type EditalExtraction,
  type ExtractorOutput,
} from '../domain/schema.ts';
import type {
  ArquivoEntrada,
  OficioGerado,
  PreprocessorPort,
  ExtractorPort,
  NormaVerifierPort,
  RiskAnalystPort,
  DrafterPort,
} from '../domain/ports.ts';
import { matchNorma } from '../domain/norma-baseline.ts';
import { categoriaParaStatus } from '../domain/categoria-status.ts';
import { checarContencao } from '../eval/tier0.ts';

/** Ports injected into the workflow (hexagonal — mocked in tests). */
export type AnalyzeDeps = {
  preprocessor: PreprocessorPort;
  extractor: ExtractorPort;
  normaVerifier: NormaVerifierPort;
  riskAnalyst: RiskAnalystPort;
  drafter: DrafterPort;
};

/** Workflow result: final extraction + ofício (null if Gate B did not fire). */
export type AnalyzeResult = {
  extracao: EditalExtraction;
  oficio: OficioGerado | null;
};

type Lei = EditalExtraction['leisReferenciadas'][number];

/**
 * RECOMPOSITION (carry-forward Phase 5). The Extractor produces
 * `ExtractorOutput` (schema WITHOUT `pontosDeAtencao` — the Risk
 * Analyst's field). We assemble the complete `EditalExtraction`:
 *  - `pontosDeAtencao: []` (explicit placeholder; the Risk Analyst fills it);
 *  - `fonte` OVERWRITTEN by the Preprocessor's trusted `FonteMeta` (Phase
 *    5 Minor #2): never trust the `fonte` the model may have set.
 * The object is VALIDATED against `EditalExtractionSchema` (defense in
 * depth + regression guaranteed by the test).
 */
function recompor(
  saida: ExtractorOutput,
  fonteConfiavel: EditalExtraction['fonte']
): EditalExtraction {
  return EditalExtractionSchema.parse({
    ...saida,
    pontosDeAtencao: [],
    fonte: fonteConfiavel,
  });
}

/**
 * GATE A (SPEC §5, closes the extractor's false-negative). Fires the
 * Verifier if ANY referenced law:
 *  - matches `matchNorma` in a RISK category — `categoriaParaStatus` ≠
 *    null and ≠ 'vigente' (i.e. revogada-* → 'revogada', zona-cinzenta →
 *    'contestada', citacao-suspeita → 'inexistente'); `vigente-ancora` is
 *    NOT a risk (anti-false-positive anchor); OR
 *  - the extractor marked `revogada=true` (the model's provisional guess
 *    — even without a baseline hit, it deserves verification).
 * None → skips the Verifier; `statusVerificado` stays at the default
 * `nao-verificado`.
 */
function gateADispara(leis: Lei[]): boolean {
  return leis.some((lei) => {
    if (lei.revogada) return true;
    const hit = matchNorma({
      numero: lei.numero,
      ano: lei.ano,
      escopo: lei.escopo,
      tipoNorma: lei.tipoNorma,
    });
    if (!hit) return false;
    const esperado = categoriaParaStatus(hit.categoria);
    // null = unknown category (no deterministic risk);
    // 'vigente' = vigente-ancora (anchor, not risk).
    return esperado !== null && esperado !== 'vigente';
  });
}

/**
 * GATE B (canonical — carry-forward Phase 7). Fires the Drafter on OR of:
 *  - some `incoerencia` with severity ∈ {alta, media}; OR
 *  - some `trechoAmbiguo`; OR
 *  - some `pontoDeAtencao.recomendaManifestacao === true`.
 * OR makes a model coherence inconsistency safe by default (the
 * manifestation only stops being generated when NOTHING justifies it).
 */
function gateBDispara(e: EditalExtraction): boolean {
  const incoerenciaGrave = e.incoerencias.some(
    (i) => i.severidade === 'alta' || i.severidade === 'media'
  );
  const temAmbiguo = e.trechosAmbiguos.length > 0;
  const recomendaManifestacao = e.pontosDeAtencao.some(
    (p) => p.recomendaManifestacao === true
  );
  return incoerenciaGrave || temAmbiguo || recomendaManifestacao;
}

/**
 * Orchestrates the pipeline with the 2 gates. An adapter failure
 * propagates (without silencing); a Tier 0 violation is a fatal error
 * (throws — never returns a partial doc).
 */
export async function analyzeEdital(
  input: ArquivoEntrada,
  deps: AnalyzeDeps
): Promise<AnalyzeResult> {
  // 1. Preprocess — plain text + trusted FonteMeta (observed, not from the LLM).
  const { texto, fonte } = await deps.preprocessor.preprocessar(input);

  // 2. Extractor — ExtractorOutput (schema v3 WITHOUT pontosDeAtencao).
  const saida = await deps.extractor.extrair(texto, fonte);

  // 3. RECOMPOSITION — pontosDeAtencao:[] + fonte = the Preprocessor's;
  //    validated against the EditalExtractionSchema.
  let extracao = recompor(saida, {
    pdfNativo: fonte.pdfNativo,
    ocr: fonte.ocr,
    paginas: fonte.paginas,
    url: fonte.url,
  });

  // 4. GATE A — matchNorma over ALL laws (or revogada=true from the extractor).
  if (gateADispara(extracao.leisReferenciadas)) {
    // 5. Verifier (conditional) — fills statusVerificado/fonteVerificacao.
    extracao = await deps.normaVerifier.verificar(extracao);
  }

  // 6. Risk Analyst — fills pontosDeAtencao consuming statusVerificado.
  extracao = await deps.riskAnalyst.analisar(extracao);

  // 7. GATE B — incoerencia>=media OR ambiguous excerpt OR recomendaManifestacao.
  let oficioGerado: OficioGerado | null = null;
  if (gateBDispara(extracao)) {
    // 8. Drafter (conditional) — OficioGerado | null (defensive).
    oficioGerado = await deps.drafter.redigir(extracao);
  }

  // 9. TIER 0 — structural containment as a FATAL ERROR. Any violation =>
  //    job fails; NEVER return an ofício/analysis with a containment violation.
  const { violacoes } = checarContencao({
    extracao,
    oficio: oficioGerado ?? null,
  });
  if (violacoes.length > 0) {
    const detalhe = violacoes
      .map((v) => `[${v.tipo}] ${v.detalhe}`)
      .join(' | ');
    throw new Error(
      `Tier 0: structural containment violation — job aborted ` +
        `(${violacoes.length}): ${detalhe}`
    );
  }

  // 10. Returns the final extraction + ofício (null if Gate B did not fire).
  return { extracao, oficio: oficioGerado ?? null };
}
