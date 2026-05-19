/**
 * Envelope for the edital input persisted in `Job.inputRef`.
 *
 * DECISION (documented, simple choice): the edital content is stored
 * INLINE — a JSON `{ nomeArquivo, contentBase64 }` serialized into the
 * `inputRef` field (String on Job). No blob storage / external bucket
 * (Supabase Storage / S3) in V0: real editais are small (< ~5 MB in the
 * corpus; the Preprocessor anti zip-bomb cap is 50 MB), single-user, and
 * this eliminates an entire infra dependency. base64 guarantees a
 * round-trip of arbitrary bytes (binary zip/pdf) through a text column.
 *
 * `/api/job` (Vercel) WRITES the envelope; the worker READS it and
 * rebuilds the `ArquivoEntrada`. V1 DEBT: for large/multi-user editais,
 * swap to a bucket reference (change only these two functions — boundary).
 */
import type { ArquivoEntrada } from '../domain/ports.ts';

type Envelope = { nomeArquivo: string; contentBase64: string };

export function empacotarInput(
  nomeArquivo: string,
  bytes: Uint8Array
): string {
  const env: Envelope = {
    nomeArquivo,
    contentBase64: Buffer.from(bytes).toString('base64'),
  };
  return JSON.stringify(env);
}

export function desempacotarInput(inputRef: string): ArquivoEntrada {
  const env = JSON.parse(inputRef) as Envelope;
  return {
    nomeArquivo: env.nomeArquivo,
    bytes: new Uint8Array(Buffer.from(env.contentBase64, 'base64')),
    url: null,
  };
}
