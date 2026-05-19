/**
 * Application telemetry (SPEC §11b) — IMPLICIT zero-friction events
 * + the gold-signal (ofício diff) + grounding cost PER call.
 *
 * CRITICAL INVARIANT: telemetry NEVER takes down the pipeline.
 * `registrarSeguro` wraps every `TelemetryPort.registrar` in try/catch —
 * a telemetry failure ONLY logs (console.error) and moves on. No caller
 * should call `telemetry.registrar` directly on the production path;
 * always go through `registrarSeguro` (defense in depth against an
 * unavailable persistence adapter taking down the whole job).
 *
 * The builders below are pure (no I/O) — each event's payload is testable
 * in isolation; `registrarSeguro` is tested against a fake `TelemetryPort`
 * that THROWS (proving non-propagation).
 */
import type { TelemetryPort } from '../domain/ports.ts';
import { calcularDiffOficio, type OficioDiff } from '../domain/oficio-diff.ts';

/** Canonical event names (1 place — avoids divergeable magic strings). */
export const EVENTO = {
  /** Pipeline finished OK — total latency + aggregated cost. */
  analiseConcluida: 'analise_concluida',
  /** Edital submitted — `inputHash` to detect re-upload downstream. */
  submissao: 'submissao',
  /** Same edital re-submitted (repeated hash) — signal of her iteration. */
  reupload: 'reupload',
  /** Export triggered (type relatorio|oficio). */
  export: 'export',
  /** GOLD-SIGNAL: ofício diff generated×exported (delta metric). */
  oficioDiff: 'oficio_diff',
  /** Exported ofício differs from generated (boolean shortcut of the gold-signal). */
  oficioEditado: 'oficio_editado',
  /** Cost/usage of ONE web grounding call (not aggregated — §11b). */
  groundingCusto: 'grounding_custo',
  /** Minimal explicit feedback (👍/👎 + text). */
  feedback: 'feedback',
} as const;

/**
 * Records a telemetry event in a NON-BLOCKING way: any exception from the
 * adapter is caught and only logged. Returns `true` if it persisted,
 * `false` if telemetry failed (the caller IGNORES the return on the happy
 * path — it exists only for tests and logs).
 */
export async function registrarSeguro(
  telemetry: TelemetryPort,
  analysisId: string,
  evento: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  try {
    await telemetry.registrar(analysisId, evento, payload);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[telemetria] event '${evento}' failed (non-blocking, ` +
        `pipeline continues): ${msg}`
    );
    return false;
  }
}

/** Stable, short hash of the edital input (to detect re-upload). */
export function hashInput(bytes: Uint8Array): string {
  // FNV-1a 32-bit — deterministic, no dependency, enough to group
  // re-submissions of the SAME edital (not a cryptographic hash).
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Payload of `analise_concluida` (latency + aggregated cost). */
export function payloadAnaliseConcluida(args: {
  latenciaMs: number;
  groundingChamadas: number;
  groundingTokensTotais: number;
  oficioGerado: boolean;
}): Record<string, unknown> {
  return {
    latenciaMs: args.latenciaMs,
    groundingChamadas: args.groundingChamadas,
    groundingTokensTotais: args.groundingTokensTotais,
    oficioGerado: args.oficioGerado,
  };
}

/**
 * Payload of the GOLD-SIGNAL + fallback decision. When the diff is empty
 * (`foiEditado=false`: accepted without editing OR did not export),
 * `sinalOuro` is `false` and the caller uses the FALLBACK (export-yes/no
 * + 👍/👎) — this payload already carries `exportou` so the fallback is
 * self-sufficient.
 */
export function payloadOficioDiff(
  diff: OficioDiff,
  exportou: boolean
): Record<string, unknown> {
  return {
    sinalOuro: diff.foiEditado,
    foiEditado: diff.foiEditado,
    linhasAdicionadas: diff.linhasAdicionadas,
    linhasRemovidas: diff.linhasRemovidas,
    distanciaCaracteres: diff.distanciaCaracteres,
    tamanhoGerado: diff.tamanhoGerado,
    tamanhoExportado: diff.tamanhoExportado,
    // FALLBACK: if sinalOuro=false, this is the available signal (§11b).
    exportou,
  };
}

/** Re-exports the diff computation (a single import for callers). */
export { calcularDiffOficio };
export type { OficioDiff };

/**
 * Payload of the cost of ONE grounding call (SPEC §11b — not just
 * aggregated: a silent cost bomb if only aggregated). `usdEstimado` is
 * marked as an estimate when the SDK does not return exact cost (usage
 * only).
 */
export function payloadGroundingCusto(args: {
  lei: string;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
}): Record<string, unknown> {
  const total =
    args.totalTokens ??
    (args.inputTokens ?? 0) + (args.outputTokens ?? 0);
  return {
    lei: args.lei,
    inputTokens: args.inputTokens ?? null,
    outputTokens: args.outputTokens ?? null,
    totalTokens: total,
    // No per-model price table in V0: we record USAGE and mark it as an
    // estimate (§11b — what matters is being PER call, visible).
    estimativa: true,
  };
}
