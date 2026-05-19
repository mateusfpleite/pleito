import { describe, it, expect } from 'vitest';
import {
  reducirPolling,
  estadoInicial,
  ehTerminal,
  type PollingState,
} from './polling.ts';

/**
 * Dashboard polling state machine (pure logic, no render nor real
 * timers). Verifies:
 *  - idle → submetendo → aguardando (after jobId) → done/erro
 *  - STOPS polling in a terminal state (done/erro) — `ehTerminal`
 *  - pending→running→done transitions reflected
 *  - network error on submit and on poll become the `erro` state with a
 *    message
 */

describe('reducirPolling — state machine', () => {
  it('starts idle, without jobId', () => {
    expect(estadoInicial.fase).toBe('idle');
    expect(estadoInicial.jobId).toBeNull();
  });

  it('idle → submetendo on submit', () => {
    const s = reducirPolling(estadoInicial, { tipo: 'submeter' });
    expect(s.fase).toBe('submetendo');
    expect(s.erro).toBeNull();
  });

  it('submetendo → aguardando on receiving jobId', () => {
    let s = reducirPolling(estadoInicial, { tipo: 'submeter' });
    s = reducirPolling(s, { tipo: 'job-criado', jobId: 'j1' });
    expect(s.fase).toBe('aguardando');
    expect(s.jobId).toBe('j1');
    expect(s.statusJob).toBe('pending');
  });

  it('submit failed → erro with message', () => {
    let s = reducirPolling(estadoInicial, { tipo: 'submeter' });
    s = reducirPolling(s, {
      tipo: 'falha',
      mensagem: 'upload vazio',
    });
    expect(s.fase).toBe('erro');
    expect(s.erro).toBe('upload vazio');
  });

  it('aguardando: pending → running (keeps waiting)', () => {
    let s: PollingState = {
      fase: 'aguardando',
      jobId: 'j1',
      statusJob: 'pending',
      resultado: null,
      erro: null,
    };
    s = reducirPolling(s, {
      tipo: 'status',
      resposta: { status: 'running', erro: null, resultado: null },
    });
    expect(s.fase).toBe('aguardando');
    expect(s.statusJob).toBe('running');
  });

  it('aguardando → concluido on receiving done with result', () => {
    let s: PollingState = {
      fase: 'aguardando',
      jobId: 'j1',
      statusJob: 'running',
      resultado: null,
      erro: null,
    };
    const resultado = {
      extracao: { municipio: 'Jaborandi' },
      oficioGerado: null,
      municipio: 'Jaborandi',
      uf: 'BA',
    };
    s = reducirPolling(s, {
      tipo: 'status',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resposta: { status: 'done', erro: null, resultado: resultado as any },
    });
    expect(s.fase).toBe('concluido');
    expect(s.resultado).toEqual(resultado);
  });

  it('aguardando → erro on receiving erro status (propagates message)', () => {
    let s: PollingState = {
      fase: 'aguardando',
      jobId: 'j1',
      statusJob: 'running',
      resultado: null,
      erro: null,
    };
    s = reducirPolling(s, {
      tipo: 'status',
      resposta: {
        status: 'erro',
        erro: 'preprocessor: zip-bomb rejeitado',
        resultado: null,
      },
    });
    expect(s.fase).toBe('erro');
    expect(s.erro).toMatch(/zip-bomb/);
  });

  it('network failure on poll → erro', () => {
    let s: PollingState = {
      fase: 'aguardando',
      jobId: 'j1',
      statusJob: 'running',
      resultado: null,
      erro: null,
    };
    s = reducirPolling(s, { tipo: 'falha', mensagem: 'rede caiu' });
    expect(s.fase).toBe('erro');
    expect(s.erro).toBe('rede caiu');
  });

  it('reiniciar returns to the initial state', () => {
    const s: PollingState = {
      fase: 'concluido',
      jobId: 'j1',
      statusJob: 'done',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resultado: {} as any,
      erro: null,
    };
    expect(reducirPolling(s, { tipo: 'reiniciar' })).toEqual(estadoInicial);
  });
});

describe('ehTerminal — stops polling on done/erro', () => {
  it('idle/submetendo/aguardando are NOT terminal', () => {
    expect(ehTerminal({ ...estadoInicial })).toBe(false);
    expect(
      ehTerminal({ ...estadoInicial, fase: 'submetendo' })
    ).toBe(false);
    expect(
      ehTerminal({ ...estadoInicial, fase: 'aguardando' })
    ).toBe(false);
  });

  it('concluido and erro ARE terminal', () => {
    expect(ehTerminal({ ...estadoInicial, fase: 'concluido' })).toBe(true);
    expect(ehTerminal({ ...estadoInicial, fase: 'erro' })).toBe(true);
  });

  it('terminal state ignores new status events (idempotent)', () => {
    const terminal: PollingState = {
      fase: 'concluido',
      jobId: 'j1',
      statusJob: 'done',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resultado: { municipio: 'X' } as any,
      erro: null,
    };
    const depois = reducirPolling(terminal, {
      tipo: 'status',
      resposta: { status: 'pending', erro: null, resultado: null },
    });
    expect(depois).toEqual(terminal);
  });
});
