/**
 * Lógica testável da superfície de revisão interna `/admin` (SPEC §11b:
 * "lista de análises + feedback + diffs — sem isso o loop não fecha").
 * Read-only. Sem auth fancy (a auth global é Phase 16; /admin fica sob a
 * mesma proteção que vier lá).
 *
 * Monta, por análise: município/uf, data, feedback (se houver), e o
 * SINAL-OURO computado (diff ofício gerado×exportado) + o FALLBACK
 * (exportou? — quando o diff é vazio/nulo). Agrupa `submissao` por
 * `inputHash` p/ marcar RE-UPLOAD (mesmo edital re-submetido).
 *
 * O caller (page.tsx server component) injeta os repos reais; o teste
 * injeta fakes. Determinístico: ordena por data desc.
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
  /** Feedback explícito (último, se houver). */
  feedback: { util: boolean; texto: string | null } | null;
  /** SINAL-OURO: o ofício exportado difere do gerado? */
  oficioFoiEditado: boolean;
  /** Magnitude do diff (chars) — 0 se sinal-ouro nulo. */
  diffDistancia: number;
  /** FALLBACK: exportou o ofício? (sinal de reserva quando ouro nulo). */
  exportouOficio: boolean;
  /** RE-UPLOAD: este edital (hash) aparece em >1 análise. */
  reupload: boolean;
};

export type AdminDeps = {
  analysisRepo: AnalysisRepo;
  telemetry: TelemetryPort;
};

function ultimoFeedback(
  eventos: EventoTelemetria[]
): { util: boolean; texto: string | null } | null {
  // listarPorAnalises devolve desc por createdAt → o 1º feedback é o
  // mais recente.
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

  // RE-UPLOAD: agrupa `submissao` por inputHash; hash em ≥2 análises
  // distintas ⇒ o MESMO edital foi re-submetido.
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
