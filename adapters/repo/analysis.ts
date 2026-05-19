/**
 * PrismaAnalysisRepo — `AnalysisRepo` (domain/ports.ts) over Prisma.
 *
 * BOUNDARY: imports the client only via `./client.ts` (sibling module).
 * The extraction JSON and the generated ofício are persisted as `Json`
 * (SPEC §9 — persist content, never derived). `oficioGerado` is nullable;
 * the exported text and its timestamp are written at export time (Phase
 * 14) — here they stay `null` on creation.
 */
import type {
  AnalysisRepo,
  AnaliseRegistro,
  OficioGerado,
} from '../../domain/ports.ts';
import type { EditalExtraction } from '../../domain/schema.ts';
import type { Prisma } from '../../prisma/generated/client.ts';
import type { PrismaClientLike } from './client.ts';

/** `analyses` row relevant to the mapping (typed subset). */
type AnalysisRow = {
  id: string;
  jobId: string;
  municipio: string;
  uf: string;
  extractionJson: unknown;
  oficioGerado: unknown;
  oficioExportado: string | null;
  oficioExportadoEm: Date | null;
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
    oficioExportadoEm: row.oficioExportadoEm ?? null,
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
    // M-2: the product invariant is 1:1 (1 analysis per job), but
    // findFirst WITHOUT ordering is non-deterministic if the invariant is
    // violated (reprocessing/bug → 2+ rows). orderBy createdAt desc makes
    // the result robust: always the most recent analysis.
    const row = (await this.prisma.analysis.findFirst({
      where: { jobId },
      orderBy: { createdAt: 'desc' },
    })) as AnalysisRow | null;
    return row ? paraRegistro(row) : null;
  }

  /**
   * Phase 14 / §9: the ofício EXPORT persists the text edited by Stefany
   * BEFORE rendering the PDF. Writes `oficioExportado` +
   * `oficioExportadoEm=now()` and returns the updated record. The caller
   * (export handler) renders the PDF from this persisted text — never
   * regenerates from the original JSON/markdown.
   */
  /**
   * Internal review surface (`/admin`, SPEC §11b). Lists the most recent
   * analyses (desc by `createdAt`). Read-only.
   */
  async listarRecentes(limite = 50): Promise<AnaliseRegistro[]> {
    const rows = (await this.prisma.analysis.findMany({
      orderBy: { createdAt: 'desc' },
      take: limite,
    })) as AnalysisRow[];
    return rows.map(paraRegistro);
  }

  async registrarOficioExportado(
    id: string,
    texto: string
  ): Promise<AnaliseRegistro> {
    const row = (await this.prisma.analysis.update({
      where: { id },
      data: {
        oficioExportado: texto,
        oficioExportadoEm: new Date(),
      },
    })) as AnalysisRow;
    return paraRegistro(row);
  }
}
