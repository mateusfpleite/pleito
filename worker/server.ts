/**
 * Servidor HTTP mínimo do worker container (SPEC §3/§14, #3 wake-up).
 *
 * O container é scale-to-zero: só desperta por HTTP. `/api/job` (Vercel)
 * faz `POST` aqui ao criar o job — ESSA requisição acorda o container. Ao
 * receber o trigger o worker drena a fila inteira via `drenarFila` (claim
 * atômico SKIP LOCKED): qualquer pending — inclusive os cujo trigger
 * falhou e ficaram repescáveis — é processado.
 *
 * O trigger responde 202 IMEDIATAMENTE (não bloqueia o caller na duração
 * do pipeline); a drenagem roda em background. `/healthz` p/ probes.
 *
 * `iniciarDrenagem` serializa as drenagens (uma por vez): se um trigger
 * chega enquanto outra drenagem roda, ela é re-executada ao final — assim
 * jobs criados durante o processamento não ficam órfãos sem outro trigger.
 */
import { createServer, type Server } from 'node:http';
import type { DrenarDeps } from './processar.ts';
import { drenarFila } from './processar.ts';

/**
 * Serializa as drenagens (uma por vez). `drenar` é injetável (default:
 * `drenarFila` real) para que o teste exercite ESTA lógica de
 * serialização — não uma cópia (testing-anti-patterns).
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
      console.error('[worker] drenagem falhou:', e);
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
      // Dispara a drenagem e responde já (não bloqueia o /api/job).
      void acordar();
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ acordado: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
}
