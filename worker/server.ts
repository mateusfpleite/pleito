/**
 * Minimal HTTP server of the worker container (SPEC §3/§14, #3 wake-up).
 *
 * The container is scale-to-zero: it only wakes up via HTTP. `/api/job`
 * (Vercel) does a `POST` here when creating the job — THAT request wakes
 * up the container. On receiving the trigger the worker drains the entire
 * queue via `drenarFila` (atomic SKIP LOCKED claim): any pending job —
 * including those whose trigger failed and became re-pickable — is
 * processed.
 *
 * The trigger responds 202 IMMEDIATELY (it does not block the caller for
 * the pipeline duration); the drain runs in the background. `/healthz`
 * for probes.
 *
 * `iniciarDrenagem` serializes the drains (one at a time): if a trigger
 * arrives while another drain is running, it is re-executed at the end —
 * so jobs created during processing are not orphaned without another
 * trigger.
 */
import { createServer, type Server } from 'node:http';
import type { DrenarDeps } from './processar.ts';
import { drenarFila } from './processar.ts';

/**
 * Serializes the drains (one at a time). `drenar` is injectable (default:
 * the real `drenarFila`) so that the test exercises THIS serialization
 * logic — not a copy (testing-anti-patterns).
 */
export function criarDrenadorSerial(
  deps: DrenarDeps,
  drenar: (d: DrenarDeps) => Promise<void> = drenarFila
): () => Promise<void> {
  let rodando = false;
  let pendente = false;
  const ciclo = async (): Promise<void> => {
    if (rodando) {
      pendente = true;
      return;
    }
    rodando = true;
    try {
      do {
        pendente = false;
        await drenar(deps);
      } while (pendente);
    } catch (e) {
      console.error('[worker] drain failed:', e);
    } finally {
      rodando = false;
    }
  };
  return ciclo;
}

export function criarServidor(deps: DrenarDeps): Server {
  const acordar = criarDrenadorSerial(deps);
  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.method === 'POST') {
      // Fires the drain and responds right away (does not block /api/job).
      void acordar();
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ acordado: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
}
