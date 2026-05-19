import { describe, it, expect, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { criarServidor, criarDrenadorSerial } from './server.ts';
import type { DrenarDeps } from './processar.ts';

/**
 * Tests of the worker HTTP server — the trigger wakes the drain;
 * /healthz responds; the serial drainer does not run concurrently and
 * re-runs if a trigger arrives during the drain. No Postgres/Gemini (fake
 * deps).
 */

function depsNoop(): DrenarDeps {
  return {
    jobRepo: {} as DrenarDeps['jobRepo'],
    analysisRepo: {} as DrenarDeps['analysisRepo'],
    analyze: vi.fn(),
  };
}

async function ouvir(server: ReturnType<typeof criarServidor>) {
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

describe('criarServidor', () => {
  it('GET /healthz → 200 ok', async () => {
    const server = criarServidor(depsNoop());
    const base = await ouvir(server);
    try {
      const res = await fetch(`${base}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    } finally {
      server.close();
    }
  });

  it('POST trigger → 202 immediately (does not block on draining)', async () => {
    const server = criarServidor(depsNoop());
    const base = await ouvir(server);
    try {
      const res = await fetch(base, {
        method: 'POST',
        body: JSON.stringify({ jobId: 'job-1' }),
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ acordado: true });
    } finally {
      server.close();
    }
  });
});

describe('criarDrenadorSerial', () => {
  it('does not run concurrent drains; re-executes if a trigger arrives mid-run', async () => {
    let emExecucao = 0;
    let maxConcorrente = 0;
    let chamadas = 0;
    let liberar!: () => void;
    let gate = new Promise<void>((r) => {
      liberar = r;
    });

    const deps = {
      jobRepo: {} as DrenarDeps['jobRepo'],
      analysisRepo: {} as DrenarDeps['analysisRepo'],
      analyze: vi.fn(),
    } as DrenarDeps;

    // Injects a slow drenarFila (gate) — exercises the REAL serialization
    // of criarDrenadorSerial (not a copy).
    const drenarLento = async () => {
      chamadas++;
      emExecucao++;
      maxConcorrente = Math.max(maxConcorrente, emExecucao);
      await gate;
      emExecucao--;
    };

    const acordar = criarDrenadorSerial(deps, drenarLento);

    const p1 = acordar(); // starts the drain (blocks on the gate)
    void acordar(); // trigger during the drain → marks pendente
    void acordar(); // idem
    // Renews the gate for the 2nd iteration (re-loop via `pendente`) and releases.
    const liberar1 = liberar;
    gate = new Promise<void>((r) => {
      liberar = r;
    });
    liberar1();
    await new Promise((r) => setTimeout(r, 0));
    liberar(); // releases the re-loop
    await p1;
    await new Promise((r) => setTimeout(r, 0));

    expect(maxConcorrente).toBe(1); // never concurrent
    expect(chamadas).toBeGreaterThanOrEqual(2); // re-ran for the pendente
  });
});
