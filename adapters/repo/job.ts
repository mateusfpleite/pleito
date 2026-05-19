/**
 * PrismaJobRepo — `JobRepo` (domain/ports.ts) sobre Prisma.
 *
 * Phase 12: `claimNext` ATÔMICO via SQL cru — Prisma NÃO expõe
 * `FOR UPDATE SKIP LOCKED` na API tipada, então usamos `$queryRaw`. A
 * cláusula garante (no Postgres real) que dois workers concorrentes nunca
 * pegam o mesmo job: o `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1` trava a
 * linha escolhida e PULA as já travadas por outra transação; o `UPDATE
 * ... RETURNING *` flipa pending→running atomicamente. SPEC §14, #3 lock.
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
   * Claim atômico (SPEC §14, #3 lock). O subselect `FOR UPDATE SKIP
   * LOCKED LIMIT 1` escolhe o pending mais antigo travando-o e ignorando
   * linhas já travadas por outra transação concorrente; o `UPDATE ...
   * RETURNING *` o flipa para `running` no mesmo passo. Resultado: dois
   * workers NUNCA pegam o mesmo job (um pega o próximo livre ou `null`).
   *
   * SQL cru via `$queryRaw` porque Prisma não expõe SKIP LOCKED. Sem
   * interpolação (query 100% estática) — nenhuma superfície de injeção.
   */
  async claimNext(): Promise<Job | null> {
    const rows = (await this.prisma.$queryRaw`
      UPDATE jobs SET status = 'running'
      WHERE id = (
        SELECT id FROM jobs
        WHERE status = 'pending'
        ORDER BY "createdAt"
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *
    `) as JobRow[];
    const row = rows[0];
    return row ? paraJob(row) : null;
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
