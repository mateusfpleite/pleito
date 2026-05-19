/**
 * PrismaTelemetry — `TelemetryPort` (domain/ports.ts) over Prisma.
 *
 * Implicit events + per-grounding-call cost logged individually (SPEC
 * §11b). `analysisId` is optional in the schema (pre-analysis events
 * exist); the port always receives an id, but we keep the column nullable
 * for future flexibility. `payload` goes as `Json`.
 */
import type {
  TelemetryPort,
  EventoTelemetria,
} from '../../domain/ports.ts';
import type { Prisma } from '../../prisma/generated/client.ts';
import type { PrismaClientLike } from './client.ts';

export class PrismaTelemetry implements TelemetryPort {
  constructor(private readonly prisma: PrismaClientLike) {}

  async registrar(
    analysisId: string,
    evento: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.prisma.telemetria.create({
      data: {
        analysisId,
        evento,
        payloadJson: payload as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Events of the given analyses (/admin review surface, §11b).
   * Read-only, off the pipeline path. Returns only those with
   * `analysisId` ∈ `ids` (non-null), newest first.
   */
  async listarPorAnalises(
    ids: string[]
  ): Promise<EventoTelemetria[]> {
    if (ids.length === 0) return [];
    const rows = (await this.prisma.telemetria.findMany({
      where: { analysisId: { in: ids } },
      orderBy: { createdAt: 'desc' },
    })) as Array<{
      analysisId: string | null;
      evento: string;
      payloadJson: unknown;
      createdAt: Date;
    }>;
    return rows
      .filter((r): r is typeof r & { analysisId: string } =>
        r.analysisId !== null
      )
      .map((r) => ({
        analysisId: r.analysisId,
        evento: r.evento,
        payload: (r.payloadJson ?? {}) as Record<string, unknown>,
        createdAt: r.createdAt,
      }));
  }
}
