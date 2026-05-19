/**
 * Envelope do input do edital persistido em `Job.inputRef`.
 *
 * DECISÃO (documentada, escolha simples): o conteúdo do edital é guardado
 * INLINE — um JSON `{ nomeArquivo, contentBase64 }` serializado no campo
 * `inputRef` (String do Job). Sem blob storage / bucket externo (Supabase
 * Storage / S3) no V0: editais reais são pequenos (< ~5 MB no corpus; o cap
 * anti zip-bomb do Preprocessor é 50 MB), single-user, e isso elimina uma
 * dependência de infra inteira. base64 garante round-trip de bytes
 * arbitrários (zip/pdf binário) através de uma coluna de texto.
 *
 * O `/api/job` (Vercel) ESCREVE o envelope; o worker o LÊ e reconstrói o
 * `ArquivoEntrada`. RESÍDUO V1: para editais grandes/multiusuário, trocar
 * por referência a um bucket (mudar só estas duas funções — boundary).
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
