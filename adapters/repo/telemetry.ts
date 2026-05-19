/**
 * PrismaTelemetry — `TelemetryPort` (domain/ports.ts) sobre Prisma.
 *
 * Eventos implícitos + custo por chamada de grounding logado
 * individualmente (SPEC §11b). `analysisId` é opcional no schema (eventos
 * pré-análise existem); a porta sempre recebe um id, mas mantemos a
 * coluna nullable para flexibilidade futura. `payload` vai como `Json`.
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
   * Eventos das análises dadas (superfície de revisão /admin, §11b).
   * Read-only, fora do caminho do pipeline. Devolve só os com
   * `analysisId` ∈ `ids` (não-nulo), mais novo primeiro.
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
