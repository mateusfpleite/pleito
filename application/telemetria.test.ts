import { describe, it, expect, vi } from 'vitest';
import {
  registrarSeguro,
  hashInput,
  payloadAnaliseConcluida,
  payloadOficioDiff,
  payloadGroundingCusto,
  calcularDiffOficio,
  EVENTO,
} from './telemetria.ts';
import type { TelemetryPort } from '../domain/ports.ts';

/**
 * Testes DETERMINÍSTICOS da telemetria de aplicação. NÃO tocam Postgres
 * nem LLM (testing-anti-patterns) — `TelemetryPort` fake in-memory e um
 * que LANÇA. Invariantes:
 *  (a) registrarSeguro grava no fake e devolve true;
 *  (b) registrarSeguro com adapter que LANÇA → NÃO propaga (devolve false,
 *      pipeline seguiria) — telemetria não-bloqueante;
 *  (c) hashInput é estável e distingue inputs diferentes (re-upload);
 *  (d) payload do sinal-ouro carrega o RESERVA quando diff vazio;
 *  (e) payload de grounding marca estimativa e soma tokens.
 */

function fakeTelemetry() {
  const eventos: Array<{
    analysisId: string;
    evento: string;
    payload: Record<string, unknown>;
  }> = [];
  const port: TelemetryPort = {
    async registrar(analysisId, evento, payload) {
      eventos.push({ analysisId, evento, payload });
    },
    async listarPorAnalises(ids) {
      return eventos
        .filter((e) => ids.includes(e.analysisId))
        .map((e) => ({ ...e, createdAt: new Date(0) }));
    },
  };
  return { port, eventos };
}

describe('registrarSeguro — NON-blocking telemetry (§11b)', () => {
  it('(a) writes to the adapter and returns true', async () => {
    const { port, eventos } = fakeTelemetry();
    const ok = await registrarSeguro(port, 'a-1', EVENTO.export, {
      tipo: 'oficio',
    });
    expect(ok).toBe(true);
    expect(eventos).toEqual([
      { analysisId: 'a-1', evento: 'export', payload: { tipo: 'oficio' } },
    ]);
  });

  it('(b) adapter that THROWS → does NOT propagate (false), pipeline would continue', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const port: TelemetryPort = {
      async registrar() {
        throw new Error('Postgres indisponível');
      },
      async listarPorAnalises() {
        return [];
      },
    };
    // Não deve REJEITAR — a invariante crítica do §11b.
    const ok = await registrarSeguro(port, 'a-1', EVENTO.export, {});
    expect(ok).toBe(false);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});

describe('hashInput — re-upload detection', () => {
  it('(c) same content → same hash; different content → different hash', () => {
    const a = new TextEncoder().encode('edital alpha');
    const a2 = new TextEncoder().encode('edital alpha');
    const b = new TextEncoder().encode('edital beta');
    expect(hashInput(a)).toBe(hashInput(a2));
    expect(hashInput(a)).not.toBe(hashInput(b));
    expect(hashInput(a)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('payloads — gold-signal + fallback + grounding', () => {
  it('(d) empty diff → sinalOuro=false and the FALLBACK (exportou) present', () => {
    const diffVazio = calcularDiffOficio('texto', 'texto');
    const p = payloadOficioDiff(diffVazio, true);
    expect(p.sinalOuro).toBe(false);
    expect(p.foiEditado).toBe(false);
    // Reserva: o sinal disponível quando o ouro é nulo.
    expect(p.exportou).toBe(true);

    const diffReal = calcularDiffOficio('a\nb', 'a\nB');
    const p2 = payloadOficioDiff(diffReal, true);
    expect(p2.sinalOuro).toBe(true);
    expect(p2.distanciaCaracteres).toBeGreaterThan(0);
  });

  it('(e) grounding: sums tokens and marks estimate', () => {
    const p = payloadGroundingCusto({
      lei: '8666/1993',
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: undefined,
    });
    expect(p.lei).toBe('8666/1993');
    expect(p.totalTokens).toBe(150); // soma quando totalTokens ausente
    expect(p.estimativa).toBe(true);
  });

  it('analise_concluida carries latency + aggregated cost', () => {
    const p = payloadAnaliseConcluida({
      latenciaMs: 90_000,
      groundingChamadas: 3,
      groundingTokensTotais: 450,
      oficioGerado: true,
    });
    expect(p).toEqual({
      latenciaMs: 90_000,
      groundingChamadas: 3,
      groundingTokensTotais: 450,
      oficioGerado: true,
    });
  });
});
