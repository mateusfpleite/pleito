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
 * Testes DETERMINÍSTICOS dos repos Prisma. NÃO usam Postgres nem
 * `prisma migrate` (não há banco no ambiente do POC — RESÍDUO de deploy
 * documentado em client.ts). Em vez de acoplar a infra externa
 * (@superpowers:testing-anti-patterns), provamos o que é nosso: o
 * MAPEAMENTO domínio↔persistência e o round-trip lógico, contra um fake
 * in-memory de `PrismaClientLike`.
 *
 * DECISÃO mock vs sqlite: mock estrutural do client gerado. Motivo (como
 * pedido pelo plano): evita divergência de dialeto Postgres↔SQLite, não
 * exige migration real, e isola exatamente a lógica que escrevemos
 * (serialização Json, defaults, null→'' do `fonte`, status enum). O fake
 * implementa SÓ a superfície (`create`/`findUnique`/`update`/`upsert`)
 * que os repos chamam, com semântica de tabela real (PK única, upsert).
 */

/** Tabela in-memory genérica chaveada por PK string. */
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
        // defaults do schema (@default(now())) materializados pelo "banco"
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

function fakePrisma(): PrismaClientLike {
  return {
    job: makeTable('id'),
    analysis: makeTable('id'),
    normaCache: makeTable('chave'),
    telemetria: makeTable('id'),
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
  it('round-trip: salvar→buscarPorId devolve registro equivalente', async () => {
    const repo = new PrismaAnalysisRepo(fakePrisma());
    const extracao = baseExtraction();

    const salvo = await repo.salvar({
      jobId: 'job-1',
      municipio: 'Mata Grande',
      uf: 'AL',
      extracao,
      oficioGerado: oficio,
      oficioExportado: null,
    });

    expect(salvo.id).toBeTruthy();
    const buscado = await repo.buscarPorId(salvo.id);
    expect(buscado).not.toBeNull();
    expect(buscado).toEqual(salvo);
    // O JSON da extração sobrevive ao round-trip sem perda (SPEC §9).
    expect(buscado!.extracao).toEqual(extracao);
    expect(buscado!.oficioGerado).toEqual(oficio);
    expect(buscado!.jobId).toBe('job-1');
  });

  it('mapeia oficioGerado ausente para null (nullable no schema)', async () => {
    const repo = new PrismaAnalysisRepo(fakePrisma());
    const salvo = await repo.salvar({
      jobId: 'job-2',
      municipio: 'Jaborandi',
      uf: 'BA',
      extracao: baseExtraction({ municipio: 'Jaborandi', uf: 'BA' }),
      oficioGerado: null,
      oficioExportado: null,
    });
    const buscado = await repo.buscarPorId(salvo.id);
    expect(buscado!.oficioGerado).toBeNull();
    expect(buscado!.oficioExportado).toBeNull();
  });

  it('buscarPorId devolve null para id inexistente', async () => {
    const repo = new PrismaAnalysisRepo(fakePrisma());
    expect(await repo.buscarPorId('nao-existe')).toBeNull();
  });
});

describe('PrismaJobRepo (CRUD básico — claim atômico é Phase 12)', () => {
  it('criar → status pending, depois buscarPorId reflete', async () => {
    const repo = new PrismaJobRepo(fakePrisma());
    const job = await repo.criar('uploads/edital.zip');
    expect(job.status).toBe('pending');
    expect(job.erro).toBeNull();
    expect(job.inputRef).toBe('uploads/edital.zip');
    expect(job.createdAt).toBeInstanceOf(Date);

    const buscado = await repo.buscarPorId(job.id);
    expect(buscado).toEqual(job);
  });

  it('marcarConcluido transiciona pending→done e limpa erro', async () => {
    const repo = new PrismaJobRepo(fakePrisma());
    const job = await repo.criar('uploads/x.zip');
    await repo.marcarConcluido(job.id);
    const depois = await repo.buscarPorId(job.id);
    expect(depois!.status).toBe('done');
    expect(depois!.erro).toBeNull();
  });

  it('marcarErro transiciona para erro e persiste a mensagem', async () => {
    const repo = new PrismaJobRepo(fakePrisma());
    const job = await repo.criar('uploads/y.zip');
    await repo.marcarErro(job.id, 'preprocessor falhou: zip corrompido');
    const depois = await repo.buscarPorId(job.id);
    expect(depois!.status).toBe('erro');
    expect(depois!.erro).toBe('preprocessor falhou: zip corrompido');
  });

  it('buscarPorId devolve null para id inexistente', async () => {
    const repo = new PrismaJobRepo(fakePrisma());
    expect(await repo.buscarPorId('nope')).toBeNull();
  });

  it('claimNext lança (é Phase 12, não simular o lock atômico)', async () => {
    const repo = new PrismaJobRepo(fakePrisma());
    await expect(repo.claimNext()).rejects.toThrow(/Phase 12/);
  });
});

describe('PrismaNormaCache (get/set + reuso)', () => {
  it('gravar → obter devolve a entrada equivalente', async () => {
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

  it('obter devolve null para chave ausente (miss)', async () => {
    const cache = new PrismaNormaCache(fakePrisma());
    expect(await cache.obter('lei:9999:2099')).toBeNull();
  });

  it('gravar duas vezes a mesma chave faz upsert (reuso, não duplica)', async () => {
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
    // upsert: uma única linha para a chave (não inseriu duplicata).
    expect(
      (prisma.normaCache as unknown as { rows: Map<string, unknown> })
        .rows.size
    ).toBe(1);
  });

  it('coluna fonte null mapeia para string vazia no domínio', async () => {
    const prisma = fakePrisma();
    const cache = new PrismaNormaCache(prisma);
    // Simula linha legada com fonte NULL inserida fora do adapter.
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
  it('registrar grava evento com analysisId e payload Json', async () => {
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
});

describe('boundary / fábrica de produção', () => {
  it('criarPrismaClient lança erro acionável (RESÍDUO de banco)', () => {
    expect(() => criarPrismaClient()).toThrow(/RESÍDUO de banco/);
  });
});
