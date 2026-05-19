import { describe, it, expect, vi } from 'vitest';
import { criarJobPOST } from './handler.ts';
import type { Job, JobRepo } from '../../../domain/ports.ts';

/**
 * Testes DETERMINÍSTICOS da rota /api/job — lógica isolada, sem servidor
 * Next nem Postgres nem worker real (testing-anti-patterns: provar o
 * comportamento da rota, não a infra). `fetch` do trigger é MOCKADO; o
 * `JobRepo` é um fake in-memory.
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
  it('cria Job pending e retorna { jobId }', async () => {
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

  it('dispara POST no WORKER_URL com { jobId } (acorda scale-to-zero)', async () => {
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

  it('persiste o input no inputRef recuperável pelo worker', async () => {
    const repo = fakeJobRepo();
    const POST = criarJobPOST({
      jobRepo: repo,
      workerUrl: 'http://w/t',
      fetchImpl: async () => new Response(null, { status: 202 }),
    });
    await POST(reqComTexto('CONTEÚDO DO EDITAL XYZ'));

    // O worker reconstrói ArquivoEntrada do inputRef (envelope JSON
    // base64) — round-trip do conteúdo sem blob externo.
    const env = JSON.parse(repo.jobs[0].inputRef) as {
      nomeArquivo: string;
      contentBase64: string;
    };
    expect(
      Buffer.from(env.contentBase64, 'base64').toString('utf-8')
    ).toBe('CONTEÚDO DO EDITAL XYZ');
  });

  it('falha do trigger NÃO perde o job (fica pending p/ repesca)', async () => {
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
    // O job foi criado e a resposta é OK mesmo com trigger falho:
    // a repesca do worker (claimNext no próximo wake) pega o pending.
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toBe('job-1');
    expect(repo.jobs[0].status).toBe('pending');
  });

  it('rejeita upload vazio com 400 (sem criar job)', async () => {
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
