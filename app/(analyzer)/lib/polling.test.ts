import { describe, it, expect } from 'vitest';
import {
  reducirPolling,
  estadoInicial,
  ehTerminal,
  type PollingState,
} from './polling.ts';

/**
 * Máquina de estado do polling do dashboard (lógica pura, sem render nem
 * timers reais). Verifica:
 *  - idle → submetendo → aguardando (após jobId) → done/erro
 *  - PARA de pollar em estado terminal (done/erro) — `ehTerminal`
 *  - transições pending→running→done refletidas
 *  - erro de rede no submit e no poll viram estado `erro` com mensagem
 */

describe('reducirPolling — máquina de estado', () => {
  it('começa idle, sem jobId', () => {
    expect(estadoInicial.fase).toBe('idle');
    expect(estadoInicial.jobId).toBeNull();
  });

  it('idle → submetendo ao enviar', () => {
    const s = reducirPolling(estadoInicial, { tipo: 'submeter' });
    expect(s.fase).toBe('submetendo');
    expect(s.erro).toBeNull();
  });

  it('submetendo → aguardando ao receber jobId', () => {
    let s = reducirPolling(estadoInicial, { tipo: 'submeter' });
    s = reducirPolling(s, { tipo: 'job-criado', jobId: 'j1' });
    expect(s.fase).toBe('aguardando');
    expect(s.jobId).toBe('j1');
    expect(s.statusJob).toBe('pending');
  });

  it('submeter falhou → erro com mensagem', () => {
    let s = reducirPolling(estadoInicial, { tipo: 'submeter' });
    s = reducirPolling(s, {
      tipo: 'falha',
      mensagem: 'upload vazio',
    });
    expect(s.fase).toBe('erro');
    expect(s.erro).toBe('upload vazio');
  });

  it('aguardando: pending → running (continua aguardando)', () => {
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

  it('aguardando → concluido ao receber done com resultado', () => {
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

  it('aguardando → erro ao receber status erro (propaga mensagem)', () => {
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

  it('falha de rede no poll → erro', () => {
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

  it('reiniciar volta ao estado inicial', () => {
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

describe('ehTerminal — para de pollar em done/erro', () => {
  it('idle/submetendo/aguardando NÃO são terminais', () => {
    expect(ehTerminal({ ...estadoInicial })).toBe(false);
    expect(
      ehTerminal({ ...estadoInicial, fase: 'submetendo' })
    ).toBe(false);
    expect(
      ehTerminal({ ...estadoInicial, fase: 'aguardando' })
    ).toBe(false);
  });

  it('concluido e erro SÃO terminais', () => {
    expect(ehTerminal({ ...estadoInicial, fase: 'concluido' })).toBe(true);
    expect(ehTerminal({ ...estadoInicial, fase: 'erro' })).toBe(true);
  });

  it('estado terminal ignora novos eventos de status (idempotente)', () => {
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
