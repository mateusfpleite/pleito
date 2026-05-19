/**
 * Testable logic for the internal `/admin` review surface (SPEC §11b:
 * "list of analyses + feedback + diffs — without this the loop never
 * closes"). Read-only. No fancy auth (global auth is Phase 16; /admin
 * sits under whatever protection ships there).
 *
 * Builds, per analysis: município/uf, date, feedback (if any), and the
 * computed GOLD-SIGNAL (generated×exported ofício diff) + the FALLBACK
 * (exported? — when the diff is empty/null). Groups `submissao` by
 * `inputHash` to flag RE-UPLOAD (same edital re-submitted).
 *
 * The caller (page.tsx server component) injects the real repos; the
 * test injects fakes. Deterministic: orders by date desc.
 */
import type {
  AnalysisRepo,
  TelemetryPort,
  EventoTelemetria,
} from '../../domain/ports.ts';
import { calcularDiffOficio } from '../../application/telemetria.ts';

export type LinhaAdmin = {
  analysisId: string;
  jobId: string;
  municipio: string;
  uf: string;
  criadoEm: string | null;
  /** Explicit feedback (latest, if any). */
  feedback: { util: boolean; texto: string | null } | null;
  /** GOLD-SIGNAL: does the exported ofício differ from the generated one? */
  oficioFoiEditado: boolean;
  /** Diff magnitude (chars) — 0 if gold signal is null. */
  diffDistancia: number;
  /** FALLBACK: was the ofício exported? (backup signal when gold is null). */
  exportouOficio: boolean;
  /** RE-UPLOAD: this edital (hash) appears in >1 analysis. */
  reupload: boolean;
};

export type AdminDeps = {
  analysisRepo: AnalysisRepo;
  telemetry: TelemetryPort;
};

function ultimoFeedback(
  eventos: EventoTelemetria[]
): { util: boolean; texto: string | null } | null {
  // listarPorAnalises returns desc by createdAt → the 1st feedback is
  // the most recent one.
  const f = eventos.find((e) => e.evento === 'feedback');
  if (!f) return null;
  return {
    util: f.payload.util === true,
    texto:
      typeof f.payload.texto === 'string' ? f.payload.texto : null,
  };
}

export async function listarAdmin(
  deps: AdminDeps,
  limite = 50
): Promise<LinhaAdmin[]> {
  const analises = await deps.analysisRepo.listarRecentes(limite);
  const ids = analises.map((a) => a.id);
  const eventos = await deps.telemetry.listarPorAnalises(ids);

  // RE-UPLOAD: group `submissao` by inputHash; a hash in ≥2 distinct
  // analyses ⇒ the SAME edital was re-submitted.
  const analisesPorHash = new Map<string, Set<string>>();
  for (const e of eventos) {
    if (e.evento !== 'submissao') continue;
    const h = e.payload.inputHash;
    if (typeof h !== 'string') continue;
    const set = analisesPorHash.get(h) ?? new Set<string>();
    set.add(e.analysisId);
    analisesPorHash.set(h, set);
  }
  const hashDaAnalise = new Map<string, string>();
  for (const e of eventos) {
    if (e.evento === 'submissao' && typeof e.payload.inputHash === 'string') {
      hashDaAnalise.set(e.analysisId, e.payload.inputHash);
    }
  }

  return analises.map((a) => {
    const evs = eventos.filter((e) => e.analysisId === a.id);
    const exportouOficio = evs.some(
      (e) => e.evento === 'export' && e.payload.tipo === 'oficio'
    );
    const markdownGerado = a.oficioGerado?.markdown ?? null;
    const diff =
      markdownGerado !== null
        ? calcularDiffOficio(markdownGerado, a.oficioExportado)
        : null;
    const hash = hashDaAnalise.get(a.id);
    const reupload =
      hash !== undefined &&
      (analisesPorHash.get(hash)?.size ?? 0) > 1;

    return {
      analysisId: a.id,
      jobId: a.jobId,
      municipio: a.municipio,
      uf: a.uf,
      criadoEm: a.oficioExportadoEm
        ? a.oficioExportadoEm.toISOString()
        : null,
      feedback: ultimoFeedback(evs),
      oficioFoiEditado: diff?.foiEditado ?? false,
      diffDistancia: diff?.distanciaCaracteres ?? 0,
      exportouOficio,
      reupload,
    };
  });
}
