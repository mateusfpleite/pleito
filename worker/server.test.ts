import { describe, it, expect, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { criarServidor, criarDrenadorSerial } from './server.ts';
import type { DrenarDeps } from './processar.ts';

/**
 * Testes do servidor HTTP do worker — trigger acorda a drenagem; /healthz
 * responde; o drenador serial não roda concorrente e re-executa se chega
 * trigger durante a drenagem. Sem Postgres/Gemini (deps fakes).
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

  it('POST trigger → 202 imediato (não bloqueia na drenagem)', async () => {
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
  it('não roda drenagens concorrentes; re-executa se chega trigger no meio', async () => {
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

    // Injeta um drenarFila lento (gate) — exercita a serialização REAL
    // de criarDrenadorSerial (não uma cópia).
    const drenarLento = async () => {
      chamadas++;
      emExecucao++;
      maxConcorrente = Math.max(maxConcorrente, emExecucao);
      await gate;
      emExecucao--;
    };

    const acordar = criarDrenadorSerial(deps, drenarLento);

    const p1 = acordar(); // inicia a drenagem (bloqueia no gate)
    void acordar(); // trigger durante a drenagem → marca pendente
    void acordar(); // idem
    // Renova o gate p/ a 2ª iteração (re-loop por `pendente`) e libera.
    const liberar1 = liberar;
    gate = new Promise<void>((r) => {
      liberar = r;
    });
    liberar1();
    await new Promise((r) => setTimeout(r, 0));
    liberar(); // libera o re-loop
    await p1;
    await new Promise((r) => setTimeout(r, 0));

    expect(maxConcorrente).toBe(1); // nunca concorrente
    expect(chamadas).toBeGreaterThanOrEqual(2); // re-executou p/ o pendente
  });
});
