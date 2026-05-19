/**
 * PURE state machine for the single-edital dashboard polling (SPEC §8).
 *
 * Isolated from React on purpose: `page.tsx` only fires the effects
 * (POST /api/job, setInterval on /api/status, abort) and dispatches
 * actions here. The whole transition rule — when to stop polling, how to
 * propagate errors, idempotency in a terminal state — is testable
 * without render or timers.
 *
 * Phases:
 *   idle       — nothing submitted yet (upload form visible)
 *   submetendo — POST /api/job in flight
 *   aguardando — job created; /api/status polling active (pending/running)
 *   concluido  — status=done with a result → renders the panels
 *   erro       — failure (submit, network, or job with status=erro)
 *
 * The pipeline takes ~70-160s; `aguardando` is a long, expected state —
 * the UI must make clear it is PROCESSING, not stuck (uses `statusJob`).
 */
import type { JobStatus, StatusResponse, StatusResultado } from './types.ts';

export type Fase =
  | 'idle'
  | 'submetendo'
  | 'aguardando'
  | 'concluido'
  | 'erro';

export type PollingState = {
  fase: Fase;
  jobId: string | null;
  /** Last Job status observed in the poll (pending/running). */
  statusJob: JobStatus;
  resultado: StatusResultado | null;
  erro: string | null;
};

export const estadoInicial: PollingState = {
  fase: 'idle',
  jobId: null,
  statusJob: 'pending',
  resultado: null,
  erro: null,
};

export type PollingAction =
  | { tipo: 'submeter' }
  | { tipo: 'job-criado'; jobId: string }
  | { tipo: 'status'; resposta: StatusResponse }
  | { tipo: 'falha'; mensagem: string }
  | { tipo: 'reiniciar' };

/** Terminal state: polling MUST stop (do not schedule a new tick). */
export function ehTerminal(s: PollingState): boolean {
  return s.fase === 'concluido' || s.fase === 'erro';
}

export function reducirPolling(
  s: PollingState,
  a: PollingAction
): PollingState {
  if (a.tipo === 'reiniciar') return estadoInicial;

  // Idempotency: in a terminal state, ignore late status events (an
  // in-flight tick may arrive after done/erro — must not "resurrect").
  if (ehTerminal(s) && a.tipo === 'status') return s;

  switch (a.tipo) {
    case 'submeter':
      return { ...estadoInicial, fase: 'submetendo' };

    case 'job-criado':
      return {
        ...s,
        fase: 'aguardando',
        jobId: a.jobId,
        statusJob: 'pending',
        erro: null,
      };

    case 'status': {
      const r = a.resposta;
      if (r.status === 'erro') {
        return {
          ...s,
          fase: 'erro',
          statusJob: 'erro',
          erro: r.erro ?? 'job terminou com erro sem mensagem',
        };
      }
      if (r.status === 'done') {
        return {
          ...s,
          fase: 'concluido',
          statusJob: 'done',
          resultado: r.resultado,
          erro: null,
        };
      }
      // pending | running — keep waiting (long state, ~70-160s).
      return { ...s, fase: 'aguardando', statusJob: r.status };
    }

    case 'falha':
      return { ...s, fase: 'erro', erro: a.mensagem };
  }
}
