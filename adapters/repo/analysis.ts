/**
 * PrismaAnalysisRepo — `AnalysisRepo` (domain/ports.ts) sobre Prisma.
 *
 * BOUNDARY: importa o client só via `./client.ts` (módulo irmão). O JSON
 * da extração e o ofício gerado são persistidos como `Json` (SPEC §9 —
 * persistir conteúdo, nunca derivado). `oficioGerado` é nullable; o
 * texto exportado e seu carimbo de tempo são gravados na exportação
 * (Phase 14) — aqui ficam `null` na criação.
 */
import type {
  AnalysisRepo,
  AnaliseRegistro,
  OficioGerado,
} from '../../domain/ports.ts';
import type { EditalExtraction } from '../../domain/schema.ts';
import type { Prisma } from '../../prisma/generated/client.ts';
import type { PrismaClientLike } from './client.ts';

/** Linha de `analyses` relevante ao mapeamento (subconjunto tipado). */
type AnalysisRow = {
  id: string;
  jobId: string;
  municipio: string;
  uf: string;
  extractionJson: unknown;
  oficioGerado: unknown;
  oficioExportado: string | null;
};

function paraRegistro(row: AnalysisRow): AnaliseRegistro {
  return {
    id: row.id,
    jobId: row.jobId,
    municipio: row.municipio,
    uf: row.uf,
    extracao: row.extractionJson as EditalExtraction,
    oficioGerado: (row.oficioGerado as OficioGerado | null) ?? null,
    oficioExportado: row.oficioExportado ?? null,
  };
}

export class PrismaAnalysisRepo implements AnalysisRepo {
  constructor(private readonly prisma: PrismaClientLike) {}

  async salvar(
    registro: Omit<AnaliseRegistro, 'id'>
  ): Promise<AnaliseRegistro> {
    const row = (await this.prisma.analysis.create({
      data: {
        jobId: registro.jobId,
        municipio: registro.municipio,
        uf: registro.uf,
        extractionJson:
          registro.extracao as unknown as Prisma.InputJsonValue,
        oficioGerado:
          (registro.oficioGerado as unknown as Prisma.InputJsonValue) ??
          undefined,
        oficioExportado: registro.oficioExportado ?? null,
      },
    })) as AnalysisRow;
    return paraRegistro(row);
  }

  async buscarPorId(id: string): Promise<AnaliseRegistro | null> {
    const row = (await this.prisma.analysis.findUnique({
      where: { id },
    })) as AnalysisRow | null;
    return row ? paraRegistro(row) : null;
  }

  async buscarPorJobId(
    jobId: string
  ): Promise<AnaliseRegistro | null> {
    // M-2: a invariante de produto é 1:1 (1 análise por job), mas
    // findFirst SEM ordenação é não-determinístico se a invariante for
    // violada (reprocesso/bug → 2+ linhas). orderBy createdAt desc
    // torna o resultado robusto: sempre a análise mais recente.
    const row = (await this.prisma.analysis.findFirst({
      where: { jobId },
      orderBy: { createdAt: 'desc' },
    })) as AnalysisRow | null;
    return row ? paraRegistro(row) : null;
  }
}
