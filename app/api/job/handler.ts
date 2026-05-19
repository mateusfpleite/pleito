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

/**
 * I-1 — Guard de tamanho UPSTREAM (antes de empacotar/persistir).
 *
 * O cap anti zip-bomb do Preprocessor (`MAX_DESCOMPRIMIDO_BYTES` = 50 MB)
 * só roda DENTRO do worker, DEPOIS de o input já ter trafegado no body do
 * POST e sido persistido em `Job.inputRef`. Sem um teto aqui, um upload
 * grande: (a) infla ~33 % ao virar base64 no envelope → row gigante; e
 * (b) na Vercel Hobby o platform corta o body em ~4.5 MB ANTES do nosso
 * código, gerando um 413 opaco do edge sem Job criado.
 *
 * RACIONAL DO NÚMERO (8 MiB pré-base64):
 * - Editais reais do corpus ficam < ~5 MB (o maior < 5 MB) → 8 MiB cobre
 *   o pior caso real com folga, sem ser permissivo a abuso.
 * - 8 MiB de bytes crus → ~10.7 MiB em base64 no `inputRef` (×1.37):
 *   confortavelmente ABAIXO do cap de descompressão (50 MB), mantendo a
 *   invariante "teto de upload ≤ cap de descompressão" (este guard nunca
 *   deixa passar algo que o Preprocessor depois rejeitaria por tamanho).
 * - TENSÃO DE DEPLOY conhecida: a Vercel Hobby limita o body a ~4.5 MB no
 *   platform — abaixo destes 8 MiB. Em Hobby, uploads de 4.5–8 MiB são
 *   barrados pelo edge (413 opaco) ANTES do nosso 413 claro. Aceitável p/
 *   o corpus (< 5 MB); resolver no deploy (plano Pro / body maior) é
 *   resíduo documentado no SPEC §14. Mantemos 8 MiB (não 4.5) p/ não
 *   amarrar a regra de negócio a um limite de plano de hospedagem.
 */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Timeout do trigger fetch (M-3): o disparo que acorda o worker
 * scale-to-zero não pode pendurar o `/api/job` no cold start do
 * container. 2 s é suficiente p/ o worker ACEITAR a conexão (ele
 * responde e processa em background); estourar o prazo é tratado como
 * falha de trigger — engolida, job fica `pending` p/ repesca. */
const TRIGGER_TIMEOUT_MS = 2000;

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

    // I-1: barra UPSTREAM — antes de empacotar (base64 +33 %) e de criar
    // o Job. Nada é persistido nem o worker é acordado se exceder.
    if (input.bytes.length > MAX_UPLOAD_BYTES) {
      return Response.json(
        {
          erro:
            `upload grande demais: ${input.bytes.length} bytes ` +
            `excede o limite de ${MAX_UPLOAD_BYTES} bytes ` +
            `(~${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MiB). ` +
            `Editais reais ficam bem abaixo disso.`,
        },
        { status: 413 }
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
        // M-3: sem timeout, um worker em cold start penduraria o
        // /api/job. Estourar o prazo cai no catch abaixo (mesma
        // resiliência de qualquer falha de trigger — job pending).
        signal: AbortSignal.timeout(TRIGGER_TIMEOUT_MS),
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
