/**
 * Promote-to-corpus in 1 STEP (SPEC §11b) — takes a persisted analysis
 * and writes it as a versioned FIXTURE under `fixtures/gold/` (NOT under
 * `output/`, which is gitignored). It becomes a Tier 0 / E2E regression
 * case: `eval/run-tier0.ts` reads `fixtures/gold/*.json`, so the file
 * enters the gate on the next run.
 *
 * SHAPE: identical to the extraction gold (the `EditalExtraction` JSON
 * directly at the root — that is what the runner's
 * `EditalExtractionSchema.safeParse` expects), PLUS a `_proveniencia`
 * block (a `_`-prefixed key → ignored by Zod schema/strip, does not break
 * the parse) documenting the curated origin.
 *
 * Telemetry designed so this is 1 step: /admin calls
 * `promoverParaCorpus(analysisId)` (button) — this function resolves the
 * analysis, serializes and writes it. Deterministic and testable (the
 * caller injects `repo`, `escrever` and `agora`; tests use fakes/temp dir
 * and assert path + content).
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AnalysisRepo } from '../domain/ports.ts';

/**
 * Versioned regression-corpus directory (NOT `output/`, which is
 * gitignored). Resolved from `process.cwd()` (project root at the Node
 * runtime — worker/Vercel function) instead of `import.meta.url`: the
 * latter makes Next's webpack try to resolve `../fixtures/gold` as a
 * module at build time. The caller can override via `deps.dir`.
 */
export const GOLD_DIR = join(process.cwd(), 'fixtures', 'gold');

/** Filename-safe slug from municipality/uf. */
export function slugFixture(municipio: string, uf: string): string {
  const base = `${municipio}-${uf}`
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'analise';
}

export type PromoverDeps = {
  analysisRepo: AnalysisRepo;
  /** Injectable writer (default: fs). Tests pass a fake/temp dir. */
  escrever?: (caminho: string, conteudo: string) => Promise<void>;
  /** Injectable clock (deterministic provenance in tests). */
  agora?: () => Date;
  /** Target directory (default: `fixtures/gold/`). */
  dir?: string;
};

export type ResultadoPromocao = {
  caminho: string;
  nomeArquivo: string;
};

/**
 * Promotes the analysis `analysisId` to `fixtures/gold/`. Throws if the
 * analysis does not exist (1 step only makes sense over something
 * persisted). Returns the path/name of the written file.
 */
export async function promoverParaCorpus(
  analysisId: string,
  deps: PromoverDeps
): Promise<ResultadoPromocao> {
  const analise = await deps.analysisRepo.buscarPorId(analysisId);
  if (!analise) {
    throw new Error(
      `promoverParaCorpus: análise ${analysisId} não encontrada ` +
        `(promote-to-corpus exige análise persistida).`
    );
  }

  const escrever =
    deps.escrever ??
    (async (caminho, conteudo) => {
      await writeFile(caminho, conteudo, 'utf-8');
    });
  const agora = deps.agora ?? (() => new Date());
  const dir = deps.dir ?? GOLD_DIR;

  const slug = slugFixture(analise.municipio, analise.uf);
  const nomeArquivo = `promovido-${slug}.json`;
  const caminho = `${dir}/${nomeArquivo}`;

  // Gold shape: the EditalExtraction at the ROOT (same as the others) +
  // `_proveniencia` (a `_*` key is stripped by the schema → does not
  // break the Tier 0 runner parse). Includes the generated/exported
  // ofício so the case exercises Tier 0 over the ofício too (real
  // regression).
  const fixture = {
    ...analise.extracao,
    _proveniencia: {
      origem: 'promote-to-corpus (SPEC §11b, Phase 15)',
      analysisId: analise.id,
      jobId: analise.jobId,
      municipio: analise.municipio,
      uf: analise.uf,
      promovidoEm: agora().toISOString(),
      temOficioGerado: analise.oficioGerado !== null,
      oficioFoiEditado:
        analise.oficioExportado !== null &&
        analise.oficioGerado !== null &&
        analise.oficioExportado !== analise.oficioGerado.markdown,
    },
  };

  await escrever(caminho, `${JSON.stringify(fixture, null, 2)}\n`);
  return { caminho, nomeArquivo };
}
