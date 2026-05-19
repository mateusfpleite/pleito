/**
 * Máquina de estado PURA do polling do dashboard single-edital (SPEC §8).
 *
 * Isolada do React de propósito: o `page.tsx` só dispara os efeitos
 * (POST /api/job, setInterval em /api/status, abort) e despacha ações
 * aqui. Toda a regra de transição — quando parar de pollar, como propagar
 * erro, idempotência em estado terminal — é testável sem render nem timers.
 *
 * Fases:
 *   idle       — nada enviado ainda (formulário de upload visível)
 *   submetendo — POST /api/job em voo
 *   aguardando — job criado; polling de /api/status ativo (pending/running)
 *   concluido  — status=done com resultado → renderiza painéis
 *   erro       — falha (submit, rede, ou job com status=erro)
 *
 * O pipeline leva ~70-160s; `aguardando` é estado longo e esperado — a UI
 * deve deixar claro que está PROCESSANDO, não travado (usa `statusJob`).
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
  /** Último status do Job observado no poll (pending/running). */
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

/** Estado terminal: o polling DEVE parar (não agendar novo tick). */
export function ehTerminal(s: PollingState): boolean {
  return s.fase === 'concluido' || s.fase === 'erro';
}

export function reducirPolling(
  s: PollingState,
  a: PollingAction
): PollingState {
  if (a.tipo === 'reiniciar') return estadoInicial;

  // Idempotência: em estado terminal, ignora eventos tardios de status
  // (um tick em voo pode chegar após done/erro — não deve "ressuscitar").
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
      // pending | running — continua aguardando (estado longo, ~70-160s).
      return { ...s, fase: 'aguardando', statusJob: r.status };
    }

    case 'falha':
      return { ...s, fase: 'erro', erro: a.mensagem };
  }
}
