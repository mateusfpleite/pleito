/**
 * Lógica testável da rota POST /api/job (fora do `route.ts` porque o
 * Next.js valida os exports de `route.ts` — só `GET/POST/...` e config
 * são exports válidos lá; a fábrica testável vive aqui).
 *
 * SPEC §3/§4/§14: recebe o upload do edital, cria `Job` pending e DISPARA
 * um `POST` em `WORKER_URL` para ACORDAR o container scale-to-zero (que só
 * desperta por HTTP — #3 wake-up). Responde `{ jobId }` sem bloquear na
 * resposta do worker.
 *
 * Resiliência do trigger (#3): se o `fetch` ao worker falhar (cold start,
 * rede), o job NÃO é perdido — já está `pending` e o próximo wake do
 * worker o repesca via `claimNext()`. O erro do trigger é logado e
 * engolido (não vira 5xx; o job sobrevive).
 */
import type { JobRepo } from '../../../domain/ports.ts';
import { empacotarInput } from '../../../infrastructure/input-envelope.ts';

export type JobPostDeps = {
  jobRepo: JobRepo;
  workerUrl: string;
  fetchImpl: typeof fetch;
};

/** Lê o conteúdo do edital do multipart: arquivo `file` OU campo `texto`. */
async function lerInput(
  req: Request
): Promise<{ nomeArquivo: string; bytes: Uint8Array } | null> {
  const form = await req.formData();
  const file = form.get('file');
  if (file && typeof file !== 'string') {
    const buf = new Uint8Array(await file.arrayBuffer());
    if (buf.length === 0) return null;
    return { nomeArquivo: file.name || 'edital', bytes: buf };
  }
  const texto = form.get('texto');
  if (typeof texto === 'string' && texto.trim().length > 0) {
    return {
      nomeArquivo: 'edital.txt',
      bytes: new TextEncoder().encode(texto),
    };
  }
  return null;
}

/** Fábrica testável do handler (deps injetadas). */
export function criarJobPOST(deps: JobPostDeps) {
  return async function POST(req: Request): Promise<Response> {
    const input = await lerInput(req);
    if (!input) {
      return Response.json(
        { erro: 'upload vazio: envie `file` ou `texto`' },
        { status: 400 }
      );
    }

    const inputRef = empacotarInput(input.nomeArquivo, input.bytes);
    const job = await deps.jobRepo.criar(inputRef);

    // Dispara-e-responde: acorda o worker scale-to-zero SEM bloquear na
    // resposta dele. Falha aqui NÃO perde o job (fica pending → repesca).
    try {
      await deps.fetchImpl(deps.workerUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: job.id }),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[/api/job] trigger do worker falhou (job ${job.id} fica ` +
          `pending p/ repesca): ${msg}`
      );
    }

    return Response.json({ jobId: job.id }, { status: 202 });
  };
}
