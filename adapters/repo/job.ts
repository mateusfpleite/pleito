/**
 * PrismaJobRepo — `JobRepo` (domain/ports.ts) sobre Prisma.
 *
 * Phase 11: só o CRUD básico (criar / atualizar status / buscar). O
 * `claimNext` ATÔMICO (`UPDATE ... FOR UPDATE SKIP LOCKED ... RETURNING`)
 * é Phase 12 (SPEC §14, #3 lock) e usa SQL bruto — fica `not implemented`
 * aqui de propósito para não fingir a garantia de concorrência antes da
 * fase que a testa sob 2 claims simultâneos.
 */
import type { Job, JobRepo, JobStatus } from '../../domain/ports.ts';
import type { PrismaClientLike } from './client.ts';

type JobRow = {
  id: string;
  status: string;
  erro: string | null;
  inputRef: string;
  createdAt: Date;
};

function paraJob(row: JobRow): Job {
  return {
    id: row.id,
    status: row.status as JobStatus,
    // Postgres devolve null p/ coluna nullable não setada; normaliza p/
    // honrar o contrato do domínio (`erro: string | null`, nunca undefined).
    erro: row.erro ?? null,
    inputRef: row.inputRef,
    createdAt: row.createdAt,
  };
}

export class PrismaJobRepo implements JobRepo {
  constructor(private readonly prisma: PrismaClientLike) {}

  async criar(inputRef: string): Promise<Job> {
    const row = (await this.prisma.job.create({
      data: { status: 'pending' satisfies JobStatus, inputRef },
    })) as JobRow;
    return paraJob(row);
  }

  /**
   * RESÍDUO de Phase 12: claim atômico FOR UPDATE SKIP LOCKED via
   * `$queryRaw`. Não implementado aqui — implementá-lo sem o lock real
   * mascararia o requisito de concorrência (testing-anti-patterns:
   * não simular a garantia que outra fase precisa provar).
   */
  async claimNext(): Promise<Job | null> {
    throw new Error(
      'claimNext: claim atômico (FOR UPDATE SKIP LOCKED) é Phase 12.'
    );
  }

  async marcarConcluido(id: string): Promise<void> {
    await this.prisma.job.update({
      where: { id },
      data: { status: 'done' satisfies JobStatus, erro: null },
    });
  }

  async marcarErro(id: string, erro: string): Promise<void> {
    await this.prisma.job.update({
      where: { id },
      data: { status: 'erro' satisfies JobStatus, erro },
    });
  }

  async buscarPorId(id: string): Promise<Job | null> {
    const row = (await this.prisma.job.findUnique({
      where: { id },
    })) as JobRow | null;
    return row ? paraJob(row) : null;
  }
}
