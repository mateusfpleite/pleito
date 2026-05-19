/**
 * Workflow de aplicação (hexagonal) — orquestra o pipeline SPEC §4 com os
 * 2 gates (§4, §5). Zero dependência de tecnologia: recebe os ports
 * injetados (`AnalyzeDeps`) e os compõe. Adapters concretos (Gemini, Prisma)
 * são responsabilidade da infraestrutura; este módulo é unit-testável só
 * com mocks (`analyze-edital.test.ts`).
 *
 * CONTRATO (importante):
 *  - Falha de QUALQUER adapter PROPAGA: `analyzeEdital` rejeita com o erro
 *    original; o pipeline a jusante NÃO roda (sem catch-and-continue, sem
 *    doc parcial). O caller (worker, Phase 12) marca o Job como `erro`.
 *  - Tier 0 (contenção estrutural) é ERRO FATAL: se `checarContencao`
 *    devolve qualquer violação, `analyzeEdital` LANÇA — NUNCA retorna
 *    ofício/análise com violação de contenção. O caller não pode
 *    catch-and-continue com doc parcial (carry-forward 3ª review).
 *
 * Pipeline:
 *   preprocess → extract → [recomposição] → Gate A → verifier?
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

/** Ports injetados no workflow (hexagonal — mocados nos testes). */
export type AnalyzeDeps = {
  preprocessor: PreprocessorPort;
  extractor: ExtractorPort;
  normaVerifier: NormaVerifierPort;
  riskAnalyst: RiskAnalystPort;
  drafter: DrafterPort;
};

/** Resultado do workflow: extração final + ofício (null se Gate B não disparou). */
export type AnalyzeResult = {
  extracao: EditalExtraction;
  oficio: OficioGerado | null;
};

type Lei = EditalExtraction['leisReferenciadas'][number];

/**
 * RECOMPOSIÇÃO (carry-forward Phase 5). O Extractor produz `ExtractorOutput`
 * (schema SEM `pontosDeAtencao` — campo do Risk Analyst). Montamos o
 * `EditalExtraction` completo:
 *  - `pontosDeAtencao: []` (placeholder explícito; o Risk Analyst preenche);
 *  - `fonte` SOBRESCRITO pela `FonteMeta` confiável do Preprocessor (Phase 5
 *    Minor #2): nunca confiar no `fonte` que o modelo possa ter posto.
 * O objeto é VALIDADO contra `EditalExtractionSchema` (defesa em profundidade
 * + regressão garantida pelo teste).
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
 * GATE A (SPEC §5, fecha o falso-negativo do extractor). Dispara o Verifier
 * se QUALQUER lei referenciada:
 *  - casa `matchNorma` numa categoria de RISCO — `categoriaParaStatus` ≠ null
 *    e ≠ 'vigente' (i.e. revogada-* → 'revogada', zona-cinzenta →
 *    'contestada', citacao-suspeita → 'inexistente'); `vigente-ancora` NÃO é
 *    risco (âncora anti-falso-positivo); OU
 *  - o extractor marcou `revogada=true` (palpite provisório do modelo —
 *    mesmo sem hit na baseline, merece verificação).
 * Nenhuma → pula o Verifier; `statusVerificado` fica no default
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
    // null = categoria desconhecida (sem risco determinístico);
    // 'vigente' = vigente-ancora (âncora, não risco).
    return esperado !== null && esperado !== 'vigente';
  });
}

/**
 * GATE B (canônico — carry-forward Phase 7). Dispara o Drafter por OR de:
 *  - alguma `incoerencia` com severidade ∈ {alta, media}; OU
 *  - algum `trechoAmbiguo`; OU
 *  - algum `pontoDeAtencao.recomendaManifestacao === true`.
 * OR torna inconsistência de coerência do modelo segura por padrão (a
 * manifestação só deixa de ser gerada quando NADA a justifica).
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
 * Orquestra o pipeline com os 2 gates. Falha de adapter propaga (sem
 * silenciar); violação de Tier 0 é erro fatal (lança — nunca retorna doc
 * parcial).
 */
export async function analyzeEdital(
  input: ArquivoEntrada,
  deps: AnalyzeDeps
): Promise<AnalyzeResult> {
  // 1. Preprocess — texto plano + FonteMeta confiável (observada, não do LLM).
  const { texto, fonte } = await deps.preprocessor.preprocessar(input);

  // 2. Extractor — ExtractorOutput (schema v3 SEM pontosDeAtencao).
  const saida = await deps.extractor.extrair(texto, fonte);

  // 3. RECOMPOSIÇÃO — pontosDeAtencao:[] + fonte = a do Preprocessor;
  //    validado contra o EditalExtractionSchema.
  let extracao = recompor(saida, {
    pdfNativo: fonte.pdfNativo,
    ocr: fonte.ocr,
    paginas: fonte.paginas,
    url: fonte.url,
  });

  // 4. GATE A — matchNorma em TODAS as leis (ou revogada=true do extractor).
  if (gateADispara(extracao.leisReferenciadas)) {
    // 5. Verifier (condicional) — preenche statusVerificado/fonteVerificacao.
    extracao = await deps.normaVerifier.verificar(extracao);
  }

  // 6. Risk Analyst — preenche pontosDeAtencao consumindo statusVerificado.
  extracao = await deps.riskAnalyst.analisar(extracao);

  // 7. GATE B — incoerência≥média OU trecho ambíguo OU recomendaManifestacao.
  let oficioGerado: OficioGerado | null = null;
  if (gateBDispara(extracao)) {
    // 8. Drafter (condicional) — OficioGerado | null (defensivo).
    oficioGerado = await deps.drafter.redigir(extracao);
  }

  // 9. TIER 0 — contenção estrutural como ERRO FATAL. Qualquer violação =>
  //    job falha; NUNCA retornar ofício/análise com violação de contenção.
  const { violacoes } = checarContencao({
    extracao,
    oficio: oficioGerado ?? null,
  });
  if (violacoes.length > 0) {
    const detalhe = violacoes
      .map((v) => `[${v.tipo}] ${v.detalhe}`)
      .join(' | ');
    throw new Error(
      `Tier 0: violação de contenção estrutural — job abortado ` +
        `(${violacoes.length}): ${detalhe}`
    );
  }

  // 10. Retorna a extração final + ofício (null se Gate B não disparou).
  return { extracao, oficio: oficioGerado ?? null };
}
