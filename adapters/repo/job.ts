/**
 * PrismaJobRepo — `JobRepo` (domain/ports.ts) over Prisma.
 *
 * Phase 12: `claimNext` is ATOMIC via raw SQL — Prisma does NOT expose
 * `FOR UPDATE SKIP LOCKED` in the typed API, so we use `$queryRaw`. The
 * clause guarantees (on real Postgres) that two concurrent workers never
 * pick the same job: the `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1`
 * locks the chosen row and SKIPS those already locked by another
 * transaction; the `UPDATE ... RETURNING *` flips pending→running
 * atomically. SPEC §14, #3 lock.
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
    // Postgres returns null for an unset nullable column; normalize to
    // honor the domain contract (`erro: string | null`, never undefined).
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
   * Atomic claim (SPEC §14, #3 lock). The `FOR UPDATE SKIP LOCKED LIMIT
   * 1` subselect picks the oldest pending, locking it and ignoring rows
   * already locked by another concurrent transaction; the `UPDATE ...
   * RETURNING *` flips it to `running` in the same step. Result: two
   * workers NEVER pick the same job (each takes the next free one or
   * `null`).
   *
   * Raw SQL via `$queryRaw` because Prisma does not expose SKIP LOCKED.
   * No interpolation (100% static query) — no injection surface.
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
