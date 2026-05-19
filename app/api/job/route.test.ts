import { describe, it, expect, vi } from 'vitest';
import { criarJobPOST, MAX_UPLOAD_BYTES } from './handler.ts';
import type { Job, JobRepo } from '../../../domain/ports.ts';

/**
 * DETERMINISTIC tests of the /api/job route — isolated logic, no Next
 * server, no Postgres, no real worker (testing-anti-patterns: prove the
 * route's behavior, not the infra). The trigger `fetch` is MOCKED; the
 * `JobRepo` is an in-memory fake.
 */

function fakeJobRepo(): JobRepo & { jobs: Job[] } {
  const jobs: Job[] = [];
  let seq = 0;
  return {
    jobs,
    async criar(inputRef: string) {
      const j: Job = {
        id: `job-${++seq}`,
        status: 'pending',
        erro: null,
        inputRef,
        createdAt: new Date('2026-05-19T00:00:00Z'),
      };
      jobs.push(j);
      return j;
    },
    async claimNext() {
      return null;
    },
    async marcarConcluido() {},
    async marcarErro() {},
    async buscarPorId(id) {
      return jobs.find((j) => j.id === id) ?? null;
    },
  };
}

function reqComTexto(texto: string): Request {
  const fd = new FormData();
  fd.set('texto', texto);
  return new Request('http://localhost/api/job', {
    method: 'POST',
    body: fd,
  });
}

describe('POST /api/job', () => {
  it('creates a pending Job and returns { jobId }', async () => {
    const repo = fakeJobRepo();
    const fetchSpy = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 202 }));
    const POST = criarJobPOST({
      jobRepo: repo,
      workerUrl: 'http://worker.local/trigger',
      fetchImpl: fetchSpy,
    });

    const res = await POST(reqComTexto('EDITAL DE PREGÃO ELETRÔNICO'));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toBe('job-1');
    expect(repo.jobs).toHaveLength(1);
    expect(repo.jobs[0].status).toBe('pending');
  });

  it('fires POST to WORKER_URL with { jobId } (wakes scale-to-zero)', async () => {
    const repo = fakeJobRepo();
    const fetchSpy = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 202 }));
    const POST = criarJobPOST({
      jobRepo: repo,
      workerUrl: 'http://worker.local/trigger',
      fetchImpl: fetchSpy,
    });

    await POST(reqComTexto('texto do edital'));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://worker.local/trigger');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ jobId: 'job-1' });
  });

  it('persists the input in the inputRef recoverable by the worker', async () => {
    const repo = fakeJobRepo();
    const POST = criarJobPOST({
      jobRepo: repo,
      workerUrl: 'http://w/t',
      fetchImpl: async () => new Response(null, { status: 202 }),
    });
    await POST(reqComTexto('CONTEÚDO DO EDITAL XYZ'));

    // The worker reconstructs ArquivoEntrada from the inputRef (base64
    // JSON envelope) — round-trip of the content without an external blob.
    const env = JSON.parse(repo.jobs[0].inputRef) as {
      nomeArquivo: string;
      contentBase64: string;
    };
    expect(
      Buffer.from(env.contentBase64, 'base64').toString('utf-8')
    ).toBe('CONTEÚDO DO EDITAL XYZ');
  });

  it('trigger failure does NOT lose the job (stays pending for re-pickup)', async () => {
    const repo = fakeJobRepo();
    const fetchSpy = vi.fn(async () => {
      throw new Error('worker indisponível (cold start / rede)');
    });
    const POST = criarJobPOST({
      jobRepo: repo,
      workerUrl: 'http://w/t',
      fetchImpl: fetchSpy,
    });

    const res = await POST(reqComTexto('edital'));
    // The job was created and the response is OK even with a failed
    // trigger: the worker's re-pickup (claimNext on the next wake) picks
    // up the pending one.
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toBe('job-1');
    expect(repo.jobs[0].status).toBe('pending');
  });

  it('rejects upload above MAX_UPLOAD_BYTES with 413 (without creating job or firing trigger)', async () => {
    const repo = fakeJobRepo();
    const fetchSpy = vi.fn(
      async () => new Response(null, { status: 202 })
    );
    const POST = criarJobPOST({
      jobRepo: repo,
      workerUrl: 'http://w/t',
      fetchImpl: fetchSpy,
    });

    // 1 byte above the upload ceiling (pre-base64) — barred UPSTREAM,
    // before packing/persisting (does not inflate the body or the row).
    const grande = 'x'.repeat(MAX_UPLOAD_BYTES + 1);
    const fd = new FormData();
    fd.set(
      'file',
      new File([grande], 'edital.txt', { type: 'text/plain' })
    );
    const res = await POST(
      new Request('http://localhost/api/job', {
        method: 'POST',
        body: fd,
      })
    );

    expect(res.status).toBe(413);
    const body = (await res.json()) as { erro: string };
    expect(body.erro).toMatch(/limite|grande|tamanho/i);
    expect(repo.jobs).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepts upload exactly at the limit (MAX_UPLOAD_BYTES) — normal flow', async () => {
    const repo = fakeJobRepo();
    const POST = criarJobPOST({
      jobRepo: repo,
      workerUrl: 'http://w/t',
      fetchImpl: async () => new Response(null, { status: 202 }),
    });
    const noLimite = 'x'.repeat(MAX_UPLOAD_BYTES);
    const fd = new FormData();
    fd.set(
      'file',
      new File([noLimite], 'edital.txt', { type: 'text/plain' })
    );
    const res = await POST(
      new Request('http://localhost/api/job', {
        method: 'POST',
        body: fd,
      })
    );
    expect(res.status).toBe(202);
    expect(repo.jobs).toHaveLength(1);
  });

  it('slow trigger does NOT hold the response: 202 returns and job stays pending', async () => {
    const repo = fakeJobRepo();
    // Simulates a worker in cold start: the fetch hangs until the
    // handler's AbortSignal aborts (timeout). The handler swallows it and
    // responds 202.
    const fetchSpy = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const sig = init?.signal;
          if (sig) {
            sig.addEventListener('abort', () =>
              reject(
                new DOMException('aborted', 'AbortError')
              )
            );
          }
        })
    );
    const POST = criarJobPOST({
      jobRepo: repo,
      workerUrl: 'http://w/t',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    const res = await POST(reqComTexto('edital'));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toBe('job-1');
    expect(repo.jobs[0].status).toBe('pending');
    // The handler PASSES an AbortSignal to fetch (trigger timeout).
    const [, init] = fetchSpy.mock.calls[0];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects empty upload with 400 (without creating job)', async () => {
    const repo = fakeJobRepo();
    const POST = criarJobPOST({
      jobRepo: repo,
      workerUrl: 'http://w/t',
      fetchImpl: async () => new Response(),
    });
    const fd = new FormData();
    const res = await POST(
      new Request('http://localhost/api/job', {
        method: 'POST',
        body: fd,
      })
    );
    expect(res.status).toBe(400);
    expect(repo.jobs).toHaveLength(0);
  });
});
