/**
 * Tipos do contrato HTTP que a UI consome — espelham EXATAMENTE o shape
 * devolvido por `GET /api/status/:id` (app/api/status/[id]/handler.ts):
 *   { status, erro, resultado: { extracao, oficioGerado, municipio, uf } | null }
 *
 * `extracao` chega como JSON serializado (vindo do Prisma via Response.json);
 * a UI o trata como `EditalExtraction` (o domínio é a fonte de verdade do
 * shape; o status handler só repassa o que o AnalysisRepo persistiu).
 */
import type { EditalExtraction } from '../../../domain/schema.ts';
import type { OficioGerado } from '../../../domain/ports.ts';

export type JobStatus = 'pending' | 'running' | 'done' | 'erro';

export type StatusResultado = {
  extracao: EditalExtraction;
  oficioGerado: OficioGerado | null;
  municipio: string;
  uf: string;
};

export type StatusResponse = {
  status: JobStatus;
  erro: string | null;
  resultado: StatusResultado | null;
};
