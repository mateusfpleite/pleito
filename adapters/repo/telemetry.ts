/**
 * PrismaTelemetry — `TelemetryPort` (domain/ports.ts) sobre Prisma.
 *
 * Eventos implícitos + custo por chamada de grounding logado
 * individualmente (SPEC §11b). `analysisId` é opcional no schema (eventos
 * pré-análise existem); a porta sempre recebe um id, mas mantemos a
 * coluna nullable para flexibilidade futura. `payload` vai como `Json`.
 */
import type { TelemetryPort } from '../../domain/ports.ts';
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
}
