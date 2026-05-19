import { describe, it, expect } from 'vitest';
import { PrismaAnalysisRepo } from './analysis.ts';
import { PrismaJobRepo } from './job.ts';
import { PrismaNormaCache } from './norma-cache.ts';
import { PrismaTelemetry } from './telemetry.ts';
import { criarPrismaClient, type PrismaClientLike } from './client.ts';
import { EditalExtractionSchema } from '../../domain/schema.ts';
import type { EditalExtraction } from '../../domain/schema.ts';
import type { OficioGerado } from '../../domain/ports.ts';

/**
 * DETERMINISTIC tests of the Prisma repos. They do NOT use Postgres nor
 * `prisma migrate` (there is no database in the POC environment — deploy
 * RESIDUE documented in client.ts). Instead of coupling to the external
 * infra (@superpowers:testing-anti-patterns), we prove what is ours: the
 * domain↔persistence MAPPING and the logical round-trip, against an
 * in-memory fake of `PrismaClientLike`.
 *
 * DECISION mock vs sqlite: a structural mock of the generated client.
 * Reason (as requested by the plan): avoids Postgres↔SQLite dialect
 * divergence, requires no real migration, and isolates exactly the logic we
 * wrote (Json serialization, defaults, `fonte` null→'', status enum). The
 * fake implements ONLY the surface
 * (`create`/`findUnique`/`update`/`upsert`) the repos call, with real table
 * semantics (unique PK, upsert).
 */

/** Generic in-memory table keyed by a string PK. */
function makeTable<T extends { [k: string]: unknown }>(pk: keyof T) {
  const rows = new Map<string, T>();
  let seq = 0;
  return {
    rows,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const id =
        (data[pk as string] as string | undefined) ?? `id-${++seq}`;
      const row = {
        ...data,
        [pk]: id,
        // schema defaults (@default(now())) materialized by the "database"
        createdAt: data.createdAt ?? new Date('2026-05-19T00:00:00Z'),
      } as unknown as T;
      if (rows.has(id)) {
        throw new Error(`PK duplicada: ${id}`);
      }
      rows.set(id, row);
      return row;
    },
    findUnique: async ({
      where,
    }: {
      where: Record<string, unknown>;
    }) => {
      const key = (where[pk as string] ??
        Object.values(where)[0]) as string;
      return rows.get(key) ?? null;
    },
    findFirst: async ({
      where,
      orderBy,
    }: {
      where: Record<string, unknown>;
      orderBy?: Record<string, 'asc' | 'desc'>;
    }) => {
      let matches = [...rows.values()].filter((row) =>
        Object.entries(where).every(
          ([k, v]) => (row as Record<string, unknown>)[k] === v
        )
      );
      // Models Prisma's `ORDER BY ... LIMIT 1`: sorts before taking
      // the 1st (M-2 — findFirst without orderBy is non-deterministic).
      if (orderBy) {
        const [[campo, dir]] = Object.entries(orderBy);
        matches = matches.sort((a, b) => {
          const av = (a as Record<string, unknown>)[campo] as
            | Date
            | number
            | string;
          const bv = (b as Record<string, unknown>)[campo] as
            | Date
            | number
            | string;
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return dir === 'desc' ? -cmp : cmp;
        });
      }
      return matches[0] ?? null;
    },
    findMany: async ({
      where,
      orderBy,
      take,
    }: {
      where?: Record<string, unknown>;
      orderBy?: Record<string, 'asc' | 'desc'>;
      take?: number;
    } = {}) => {
      let matches = [...rows.values()].filter((row) => {
        if (!where) return true;
        return Object.entries(where).every(([k, v]) => {
          const cell = (row as Record<string, unknown>)[k];
          // Supports the `{ in: [...] }` operator (telemetria per analyses).
          if (
            v &&
            typeof v === 'object' &&
            'in' in (v as Record<string, unknown>)
          ) {
            return (v as { in: unknown[] }).in.includes(cell);
          }
          return cell === v;
        });
      });
      if (orderBy) {
        const [[campo, dir]] = Object.entries(orderBy);
        matches = matches.sort((a, b) => {
          const av = (a as Record<string, unknown>)[campo] as
            | Date
            | number
            | string;
          const bv = (b as Record<string, unknown>)[campo] as
            | Date
            | number
            | string;
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return dir === 'desc' ? -cmp : cmp;
        });
      }
      return take != null ? matches.slice(0, take) : matches;
    },
    update: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const key = where[pk as string] as string;
      const existing = rows.get(key);
      if (!existing) throw new Error(`Row inexistente: ${key}`);
      const updated = { ...existing, ...data } as T;
      rows.set(key, updated);
      return updated;
    },
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const key = where[pk as string] as string;
      const existing = rows.get(key);
      if (existing) {
        const updated = { ...existing, ...update } as T;
        rows.set(key, updated);
        return updated;
      }
      const row = { ...create, [pk]: key } as unknown as T;
      rows.set(key, row);
      return row;
    },
  };
}

type JobRowShape = {
  id: string;
  status: string;
  erro: string | null;
  inputRef: string;
  createdAt: Date;
};

/**
 * `$queryRaw` fake that MODELS the semantics of `FOR UPDATE SKIP LOCKED`
 * without real Postgres (database RESIDUE — testing-anti-patterns: prove
 * the INVARIANT, not the engine). The atomic claim is the only operation
 * `claimNext` executes via raw SQL; the fake:
 *
 *  1. records the received SQL (template text) so the test can assert it
 *     literally contains `FOR UPDATE SKIP LOCKED` + `RETURNING` — the
 *     clause that delivers the guarantee on real Postgres;
 *  2. performs the claim ATOMICALLY and SERIALIZED over the in-memory
 *     table: selects the oldest `pending`, flips it to `running` in the
 *     SAME synchronous step and returns it. Since the pending→running
 *     transition is indivisible, two interleaved `claimNext()` NEVER
 *     observe the same pending row — exactly what SKIP LOCKED guarantees
 *     (the 2nd "skips" the already-locked/claimed row).
 */
function makeQueryRaw(jobRows: Map<string, JobRowShape>) {
  const sqlVisto: string[] = [];
  const queryRaw = async (
    strings: TemplateStringsArray | { sql?: string },
    ..._values: unknown[]
  ) => {
    const sql = Array.isArray(strings)
      ? (strings as unknown as string[]).join(' ? ')
      : ((strings as { sql?: string }).sql ?? String(strings));
    sqlVisto.push(sql);

    if (!/jobs/i.test(sql)) return [];

    // Serialized atomic claim: takes the oldest pending and flips it
    // to running indivisibly (models FOR UPDATE SKIP LOCKED).
    const pendentes = [...jobRows.values()]
      .filter((r) => r.status === 'pending')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const alvo = pendentes[0];
    if (!alvo) return [];
    alvo.status = 'running';
    return [{ ...alvo }];
  };
  return Object.assign(queryRaw, { sqlVisto });
}

function fakePrisma(): PrismaClientLike {
  const job = makeTable('id');
  const queryRaw = makeQueryRaw(
    job.rows as unknown as Map<string, JobRowShape>
  );
  return {
    job,
    analysis: makeTable('id'),
    normaCache: makeTable('chave'),
    telemetria: makeTable('id'),
    $queryRaw: queryRaw,
  } as unknown as PrismaClientLike;
}

function baseExtraction(
  overrides: Partial<EditalExtraction> = {}
): EditalExtraction {
  return EditalExtractionSchema.parse({
    municipio: 'Mata Grande',
    uf: 'AL',
    ente: {
      tipo: 'prefeitura',
      razaoSocial: 'Prefeitura Municipal de Mata Grande',
      cnpj: null,
    },
    modalidade: 'pregao-eletronico',
    numero: '16/2026',
    processoAdministrativo: null,
    dataPublicacao: null,
    dataSessao: null,
    uasg: null,
    regimeJuridico: 'lei-14133',
    objetoCorpo: 'Serviços funerários',
    objetoCapa: null,
    objetoSummary: 'Serviços funerários',
    tipoObjeto: ['servicos-funerarios-completos'],
    secretariaDemandante: null,
    valor: { estimado: null, sigiloso: true, procedencia: 'preambulo' },
    moeda: 'BRL',
    criterioJulgamento: 'menor-preco',
    agrupamento: 'lote',
    modoDisputa: 'aberto-fechado',
    regimeExecucao: null,
    vigenciaContrato: { meses: 12, prorrogavelAteMeses: null },
    vigenciaAtaRP: null,
    validadeProposta: { dias: 60 },
    habilitacao: {
      juridica: [],
      fiscalTrabalhista: [],
      economicoFinanceira: [],
      tecnica: [],
    },
    exigenciasRegulatorias: {
      licencaSanitaria: false,
      alvaraFuncionamento: false,
      vistoria: false,
      amostra: false,
      outros: [],
    },
    itensLicitados: [],
    leisReferenciadas: [
      {
        descricao: 'Lei nº 14.133/2021',
        escopo: 'federal',
        tipoNorma: 'lei',
        numero: '14133',
        ano: 2021,
        contextoNoEdital: 'Regime jurídico do edital',
        revogada: false,
        statusVerificado: 'vigente',
        fonteVerificacao: 'https://www.planalto.gov.br',
      },
    ],
    anexos: [],
    incoerencias: [],
    trechosAmbiguos: [],
    plataforma: 'LICITANET',
    subcontratacaoPermitida: false,
    intervaloMinimoLances: 100,
    prazoRecursosDiasUteis: 3,
    informacoesViabilidade: 'Demandas assistenciais',
    pontosDeAtencao: [],
    fonte: { pdfNativo: false, ocr: false, paginas: 5, url: null },
    ...overrides,
  });
}

const oficio: OficioGerado = {
  tipo: 'esclarecimento',
  markdown: '# Pedido de esclarecimento\n\nQual a vigência?',
  leisCitadas: [
    { numero: '14133', ano: 2021, afirmacaoVigencia: 'nenhuma' },
  ],
};

describe('PrismaAnalysisRepo', () => {
  it('round-trip: salvar→buscarPorId returns an equivalent record', async () => {
    const repo = new PrismaAnalysisRepo(fakePrisma());
    const extracao = baseExtraction();

    const salvo = await repo.salvar({
      jobId: 'job-1',
      municipio: 'Mata Grande',
      uf: 'AL',
      extracao,
      oficioGerado: oficio,
      oficioExportado: null,
      oficioExportadoEm: null,
    });

    expect(salvo.id).toBeTruthy();
    const buscado = await repo.buscarPorId(salvo.id);
    expect(buscado).not.toBeNull();
    expect(buscado).toEqual(salvo);
    // The extraction JSON survives the round-trip losslessly (SPEC §9).
    expect(buscado!.extracao).toEqual(extracao);
    expect(buscado!.oficioGerado).toEqual(oficio);
    expect(buscado!.jobId).toBe('job-1');
  });

  it('maps absent oficioGerado to null (nullable in schema)', async () => {
    const repo = new PrismaAnalysisRepo(fakePrisma());
    const salvo = await repo.salvar({
      jobId: 'job-2',
      municipio: 'Jaborandi',
      uf: 'BA',
      extracao: baseExtraction({ municipio: 'Jaborandi', uf: 'BA' }),
      oficioGerado: null,
      oficioExportado: null,
      oficioExportadoEm: null,
    });
    const buscado = await repo.buscarPorId(salvo.id);
    expect(buscado!.oficioGerado).toBeNull();
    expect(buscado!.oficioExportado).toBeNull();
    expect(buscado!.oficioExportadoEm).toBeNull();
  });

  it('buscarPorId returns null for a nonexistent id', async () => {
    const repo = new PrismaAnalysisRepo(fakePrisma());
    expect(await repo.buscarPorId('nao-existe')).toBeNull();
  });

  it('buscarPorJobId finds the analysis by jobId (status route)', async () => {
    const repo = new PrismaAnalysisRepo(fakePrisma());
    const salvo = await repo.salvar({
      jobId: 'job-77',
      municipio: 'Niterói',
      uf: 'RJ',
      extracao: baseExtraction({ municipio: 'Niterói', uf: 'RJ' }),
      oficioGerado: null,
      oficioExportado: null,
      oficioExportadoEm: null,
    });
    const achado = await repo.buscarPorJobId('job-77');
    expect(achado).not.toBeNull();
    expect(achado!.id).toBe(salvo.id);
    expect(achado!.jobId).toBe('job-77');
    expect(await repo.buscarPorJobId('job-inexistente')).toBeNull();
  });

  it('buscarPorJobId is deterministic: 2 analyses for the same job → the most recent (M-2)', async () => {
    const prisma = fakePrisma();
    const repo = new PrismaAnalysisRepo(prisma);
    // The product invariant is 1:1 (1 analysis/job), but if the invariant
    // is violated (reprocessing/bug), findFirst WITHOUT orderBy would be
    // non-deterministic. orderBy createdAt desc guarantees the newest one.
    const antiga = await repo.salvar({
      jobId: 'job-dup',
      municipio: 'Antiga',
      uf: 'AL',
      extracao: baseExtraction({ municipio: 'Antiga', uf: 'AL' }),
      oficioGerado: null,
      oficioExportado: null,
      oficioExportadoEm: null,
    });
    // Forces a newer createdAt on the 2nd row (the fake materializes
    // createdAt from data.createdAt when present).
    const nova = await prisma.analysis.create({
      data: {
        jobId: 'job-dup',
        municipio: 'Nova',
        uf: 'AL',
        extractionJson: baseExtraction({
          municipio: 'Nova',
          uf: 'AL',
        }),
        oficioGerado: undefined,
        oficioExportado: null,
        createdAt: new Date('2026-06-01T00:00:00Z'),
      },
    });
    const achado = await repo.buscarPorJobId('job-dup');
    expect(achado!.id).toBe((nova as { id: string }).id);
    expect(achado!.id).not.toBe(antiga.id);
    expect(achado!.municipio).toBe('Nova');
  });

  it('listarRecentes returns the newest analyses first (/admin §11b)', async () => {
    const prisma = fakePrisma();
    const repo = new PrismaAnalysisRepo(prisma);
    await repo.salvar({
      jobId: 'job-a',
      municipio: 'Antiga',
      uf: 'AL',
      extracao: baseExtraction({ municipio: 'Antiga' }),
      oficioGerado: null,
      oficioExportado: null,
      oficioExportadoEm: null,
    });
    await prisma.analysis.create({
      data: {
        jobId: 'job-b',
        municipio: 'Nova',
        uf: 'BA',
        extractionJson: baseExtraction({ municipio: 'Nova', uf: 'BA' }),
        oficioGerado: undefined,
        oficioExportado: null,
        createdAt: new Date('2026-07-01T00:00:00Z'),
      },
    });
    const lista = await repo.listarRecentes();
    expect(lista).toHaveLength(2);
    expect(lista[0].municipio).toBe('Nova'); // desc by createdAt
    expect(lista[1].municipio).toBe('Antiga');
    const limitada = await repo.listarRecentes(1);
    expect(limitada).toHaveLength(1);
    expect(limitada[0].municipio).toBe('Nova');
  });

  it('registrarOficioExportado stores the edited text + timestamp (Phase 14 / §9)', async () => {
    const repo = new PrismaAnalysisRepo(fakePrisma());
    const salvo = await repo.salvar({
      jobId: 'job-exp',
      municipio: 'Dom Basílio',
      uf: 'BA',
      extracao: baseExtraction({ municipio: 'Dom Basílio', uf: 'BA' }),
      oficioGerado: oficio,
      oficioExportado: null,
      oficioExportadoEm: null,
    });
    expect(salvo.oficioExportado).toBeNull();
    expect(salvo.oficioExportadoEm).toBeNull();

    const texto = '# Ofício editado\n\nTexto final da Stefany.';
    const atualizado = await repo.registrarOficioExportado(
      salvo.id,
      texto
    );
    // The edited text is PERSISTED; the generated JSON is preserved for diff.
    expect(atualizado.oficioExportado).toBe(texto);
    expect(atualizado.oficioExportadoEm).toBeInstanceOf(Date);
    expect(atualizado.oficioGerado).toEqual(oficio);

    // Round-trip: the subsequent read returns the persisted text.
    const relido = await repo.buscarPorId(salvo.id);
    expect(relido!.oficioExportado).toBe(texto);
    expect(relido!.oficioExportadoEm).toBeInstanceOf(Date);
  });
});

describe('PrismaJobRepo (basic CRUD — atomic claim is Phase 12)', () => {
  it('criar → status pending, then buscarPorId reflects it', async () => {
    const repo = new PrismaJobRepo(fakePrisma());
    const job = await repo.criar('uploads/edital.zip');
    expect(job.status).toBe('pending');
    expect(job.erro).toBeNull();
    expect(job.inputRef).toBe('uploads/edital.zip');
    expect(job.createdAt).toBeInstanceOf(Date);

    const buscado = await repo.buscarPorId(job.id);
    expect(buscado).toEqual(job);
  });

  it('marcarConcluido transitions pending→done and clears erro', async () => {
    const repo = new PrismaJobRepo(fakePrisma());
    const job = await repo.criar('uploads/x.zip');
    await repo.marcarConcluido(job.id);
    const depois = await repo.buscarPorId(job.id);
    expect(depois!.status).toBe('done');
    expect(depois!.erro).toBeNull();
  });

  it('marcarErro transitions to erro and persists the message', async () => {
    const repo = new PrismaJobRepo(fakePrisma());
    const job = await repo.criar('uploads/y.zip');
    await repo.marcarErro(job.id, 'preprocessor falhou: zip corrompido');
    const depois = await repo.buscarPorId(job.id);
    expect(depois!.status).toBe('erro');
    expect(depois!.erro).toBe('preprocessor falhou: zip corrompido');
  });

  it('buscarPorId returns null for a nonexistent id', async () => {
    const repo = new PrismaJobRepo(fakePrisma());
    expect(await repo.buscarPorId('nope')).toBeNull();
  });

  it('claimNext: no pending returns null', async () => {
    const repo = new PrismaJobRepo(fakePrisma());
    expect(await repo.claimNext()).toBeNull();
  });

  it('claimNext: claims the oldest pending and marks it running', async () => {
    const prisma = fakePrisma();
    const repo = new PrismaJobRepo(prisma);
    const j1 = await repo.criar('uploads/antigo.zip');
    await repo.criar('uploads/novo.zip');
    const claimed = await repo.claimNext();
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(j1.id); // ORDER BY created_at
    expect(claimed!.status).toBe('running');
  });

  it('claimNext emits SQL with FOR UPDATE SKIP LOCKED + RETURNING', async () => {
    const prisma = fakePrisma();
    const repo = new PrismaJobRepo(prisma);
    await repo.criar('uploads/a.zip');
    await repo.claimNext();
    const sql = (
      (prisma as unknown as { $queryRaw: { sqlVisto: string[] } })
        .$queryRaw.sqlVisto
    )
      .join('\n')
      .toUpperCase();
    // The clause that delivers the concurrency guarantee on real Postgres.
    expect(sql).toMatch(/FOR UPDATE\s+SKIP LOCKED/);
    expect(sql).toContain('RETURNING');
    expect(sql).toMatch(/SET\s+STATUS\s*=\s*'RUNNING'/);
    expect(sql).toMatch(/WHERE\s+STATUS\s*=\s*'PENDING'/);
    expect(sql).toMatch(/ORDER BY\s+["']?CREATEDAT/);
  });

  /**
   * CENTRAL INVARIANT (#3 lock): two concurrent workers NEVER take the same
   * job. Proven deterministically and honestly: two `claimNext()` fired
   * together (Promise.all) over 2 pending jobs must take DIFFERENT jobs;
   * with 1 pending job, one takes the job and the other gets `null` (skip
   * — it does not steal the already-claimed one).
   */
  it('claimNext: 2 simultaneous claims take DIFFERENT jobs', async () => {
    const prisma = fakePrisma();
    const repo = new PrismaJobRepo(prisma);
    const a = await repo.criar('uploads/a.zip');
    const b = await repo.criar('uploads/b.zip');

    const [c1, c2] = await Promise.all([
      repo.claimNext(),
      repo.claimNext(),
    ]);

    expect(c1).not.toBeNull();
    expect(c2).not.toBeNull();
    // The invariant: never the same id for two claims.
    expect(c1!.id).not.toBe(c2!.id);
    const ids = new Set([c1!.id, c2!.id]);
    expect(ids).toEqual(new Set([a.id, b.id]));
    expect(c1!.status).toBe('running');
    expect(c2!.status).toBe('running');
  });

  it('claimNext: 2 simultaneous claims, only 1 pending → the other gets null', async () => {
    const prisma = fakePrisma();
    const repo = new PrismaJobRepo(prisma);
    const a = await repo.criar('uploads/unico.zip');

    const [c1, c2] = await Promise.all([
      repo.claimNext(),
      repo.claimNext(),
    ]);

    const claimados = [c1, c2].filter((c) => c !== null);
    const nulos = [c1, c2].filter((c) => c === null);
    expect(claimados).toHaveLength(1);
    expect(nulos).toHaveLength(1);
    expect(claimados[0]!.id).toBe(a.id);
    expect(claimados[0]!.status).toBe('running');
  });

  it('claimNext: drains the queue (claims until pending is exhausted)', async () => {
    const prisma = fakePrisma();
    const repo = new PrismaJobRepo(prisma);
    await repo.criar('uploads/1.zip');
    await repo.criar('uploads/2.zip');
    await repo.criar('uploads/3.zip');

    const claimados: string[] = [];
    let j = await repo.claimNext();
    while (j) {
      claimados.push(j.id);
      j = await repo.claimNext();
    }
    expect(claimados).toHaveLength(3);
    expect(new Set(claimados).size).toBe(3); // never repeated
  });
});

describe('PrismaNormaCache (get/set + reuse)', () => {
  it('gravar → obter returns the equivalent entry', async () => {
    const cache = new PrismaNormaCache(fakePrisma());
    await cache.gravar({
      chave: 'lei:8666:1993',
      status: 'revogada',
      fonte: 'baseline',
    });
    const got = await cache.obter('lei:8666:1993');
    expect(got).not.toBeNull();
    expect(got!.chave).toBe('lei:8666:1993');
    expect(got!.status).toBe('revogada');
    expect(got!.fonte).toBe('baseline');
    expect(got!.verificadoEm).toBeInstanceOf(Date);
  });

  it('obter returns null for an absent key (miss)', async () => {
    const cache = new PrismaNormaCache(fakePrisma());
    expect(await cache.obter('lei:9999:2099')).toBeNull();
  });

  it('gravar the same key twice does an upsert (reuse, no duplicate)', async () => {
    const prisma = fakePrisma();
    const cache = new PrismaNormaCache(prisma);
    await cache.gravar({
      chave: 'lei:14133:2021',
      status: 'nao-verificado',
      fonte: 'baseline',
    });
    await cache.gravar({
      chave: 'lei:14133:2021',
      status: 'vigente',
      fonte: 'grounding',
    });
    const got = await cache.obter('lei:14133:2021');
    expect(got!.status).toBe('vigente');
    expect(got!.fonte).toBe('grounding');
    // upsert: a single row for the key (did not insert a duplicate).
    expect(
      (prisma.normaCache as unknown as { rows: Map<string, unknown> })
        .rows.size
    ).toBe(1);
  });

  it('null fonte column maps to empty string in the domain', async () => {
    const prisma = fakePrisma();
    const cache = new PrismaNormaCache(prisma);
    // Simulates a legacy row with NULL fonte inserted outside the adapter.
    (
      prisma.normaCache as unknown as {
        rows: Map<string, unknown>;
      }
    ).rows.set('lei:legada:2000', {
      chave: 'lei:legada:2000',
      status: 'vigente',
      fonte: null,
      verificadoEm: new Date('2026-01-01T00:00:00Z'),
    });
    const got = await cache.obter('lei:legada:2000');
    expect(got!.fonte).toBe('');
  });
});

describe('PrismaTelemetry', () => {
  it('registrar stores an event with analysisId and Json payload', async () => {
    const prisma = fakePrisma();
    const tele = new PrismaTelemetry(prisma);
    await tele.registrar('analysis-1', 'grounding.custo', {
      usd: 0.0021,
      lei: '14133/2021',
    });
    const rows = [
      ...(
        prisma.telemetria as unknown as {
          rows: Map<string, Record<string, unknown>>;
        }
      ).rows.values(),
    ];
    expect(rows).toHaveLength(1);
    expect(rows[0].analysisId).toBe('analysis-1');
    expect(rows[0].evento).toBe('grounding.custo');
    expect(rows[0].payloadJson).toEqual({
      usd: 0.0021,
      lei: '14133/2021',
    });
  });

  it('listarPorAnalises returns only the events of the requested analyses (/admin)', async () => {
    const prisma = fakePrisma();
    const tele = new PrismaTelemetry(prisma);
    await tele.registrar('a-1', 'feedback', { util: true });
    await tele.registrar('a-1', 'export', { tipo: 'oficio' });
    await tele.registrar('a-2', 'feedback', { util: false });

    const r1 = await tele.listarPorAnalises(['a-1']);
    expect(r1).toHaveLength(2);
    expect(r1.every((e) => e.analysisId === 'a-1')).toBe(true);
    expect(r1[0].createdAt).toBeInstanceOf(Date);

    const r12 = await tele.listarPorAnalises(['a-1', 'a-2']);
    expect(r12).toHaveLength(3);
    expect(await tele.listarPorAnalises([])).toEqual([]);
  });
});

describe('boundary / production factory', () => {
  it('criarPrismaClient throws an actionable error (RESÍDUO de banco)', () => {
    expect(() => criarPrismaClient()).toThrow(/RESÍDUO de banco/);
  });
});
