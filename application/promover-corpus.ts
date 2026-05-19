/**
 * Promote-to-corpus em 1 PASSO (SPEC §11b) — pega uma análise persistida
 * e a grava como FIXTURE versionada em `fixtures/gold/` (NÃO em
 * `output/`, que é gitignored). Vira caso de regressão do Tier 0 / E2E:
 * o `eval/run-tier0.ts` lê `fixtures/gold/*.json`, então o arquivo já
 * entra no gate na próxima rodada.
 *
 * SHAPE: idêntico aos gold de extração (o JSON do `EditalExtraction`
 * direto na raiz — é o que `EditalExtractionSchema.safeParse` do runner
 * espera), MAIS um bloco `_proveniencia` (chave com `_` → ignorada pelo
 * schema/strip do Zod, não quebra o parse) documentando a origem curada.
 *
 * Telemetria desenhada p/ isto ser 1 passo: o /admin chama
 * `promoverParaCorpus(analysisId)` (botão) — esta função resolve a
 * análise, serializa e escreve. Determinística e testável (o caller
 * injeta `repo`, `escrever` e `agora`; testes usam fakes/dir temp e
 * asseguram caminho + conteúdo).
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AnalysisRepo } from '../domain/ports.ts';

/**
 * Diretório versionado do corpus de regressão (NÃO `output/`, que é
 * gitignored). Resolvido a partir de `process.cwd()` (raiz do projeto no
 * runtime Node — worker/Vercel function) em vez de `import.meta.url`:
 * este último faz o webpack do Next tentar resolver `../fixtures/gold`
 * como módulo no build. O caller pode sobrescrever via `deps.dir`.
 */
export const GOLD_DIR = join(process.cwd(), 'fixtures', 'gold');

/** Slug seguro p/ nome de arquivo a partir de município/uf. */
export function slugFixture(municipio: string, uf: string): string {
  const base = `${municipio}-${uf}`
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'analise';
}

export type PromoverDeps = {
  analysisRepo: AnalysisRepo;
  /** Escritor injetável (default: fs). Testes passam um fake/dir temp. */
  escrever?: (caminho: string, conteudo: string) => Promise<void>;
  /** Relógio injetável (proveniência determinística nos testes). */
  agora?: () => Date;
  /** Diretório-alvo (default: `fixtures/gold/`). */
  dir?: string;
};

export type ResultadoPromocao = {
  caminho: string;
  nomeArquivo: string;
};

/**
 * Promove a análise `analysisId` para `fixtures/gold/`. Lança se a
 * análise não existir (1 passo só faz sentido sobre algo persistido).
 * Devolve o caminho/nome do arquivo escrito.
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

  // Shape do gold: o EditalExtraction na RAIZ (igual aos demais) +
  // `_proveniencia` (chave `_*` é stripada pelo schema → não quebra o
  // parse do runner Tier 0). Inclui o ofício gerado/exportado p/ o caso
  // exercitar o Tier 0 também sobre o ofício (regressão real).
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
