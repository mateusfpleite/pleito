/**
 * Types of the HTTP contract the UI consumes — they mirror EXACTLY the
 * shape returned by `GET /api/status/:id` (app/api/status/[id]/handler.ts):
 *   { status, erro, resultado: { extracao, oficioGerado, municipio, uf } | null }
 *
 * `extracao` arrives as serialized JSON (from Prisma via Response.json);
 * the UI treats it as `EditalExtraction` (the domain is the source of
 * truth for the shape; the status handler just relays whatever the
 * AnalysisRepo persisted).
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
