import { execFile } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import unzipper from 'unzipper';
import type {
  PreprocessorPort,
  ArquivoEntrada,
  TextoExtraido,
} from '../../domain/ports.ts';

const execFileAsync = promisify(execFile);

/** Minimum alphanumeric characters to consider the extraction usable. */
const MIN_ALFANUM = 500;

/**
 * CARRY-FORWARD Phase 3+4 — DECOMPRESSED size cap (anti zip-bomb). Real
 * editais are far below 50 MB (the largest in the corpus < 5 MB).
 * Decompressed content above this is rejected BEFORE being materialized —
 * the worker turns the rejection into a Job `erro` (clear message), never
 * OOM. Applies to: raw text/pdf, inflated gzip, and each zip entry (by the
 * `uncompressedSize` declared in the header).
 */
export const MAX_DESCOMPRIMIDO_BYTES = 50 * 1024 * 1024;

/** Boundary error: input exceeds the decompression cap (zip-bomb). */
export class EntradaGrandeDemaisError extends Error {
  constructor(detalhe: string) {
    super(
      `Entrada rejeitada: excede o limite de tamanho descomprimido ` +
        `(${MAX_DESCOMPRIMIDO_BYTES} bytes / zip-bomb) — ${detalhe}`
    );
    this.name = 'EntradaGrandeDemaisError';
  }
}

type Formato = 'zip' | 'pdf' | 'gzip' | 'texto';

/** Detection by magic bytes (without trusting the filename extension). */
function detectarFormato(bytes: Uint8Array): Formato {
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    return 'zip'; // "PK"
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  ) {
    return 'pdf'; // "%PDF"
  }
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return 'gzip'; // \x1f\x8b
  }
  return 'texto';
}

function contarAlfanum(s: string): number {
  const m = s.match(/[\p{L}\p{N}]/gu);
  return m ? m.length : 0;
}

/**
 * A header/footer repeated on every page pollutes the text and wastes
 * tokens. `pdftotext -layout` separates pages with \f (form feed):
 * identical lines present on most pages are removed.
 */
function normalizarHeaderRodape(texto: string): string {
  const paginas = texto.split('\f');
  if (paginas.length < 3) return texto;

  const freq = new Map<string, number>();
  for (const p of paginas) {
    const linhas = new Set(
      p
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length >= 4)
    );
    for (const l of linhas) freq.set(l, (freq.get(l) ?? 0) + 1);
  }

  const limite = Math.ceil(paginas.length * 0.6);
  const repetidas = new Set(
    [...freq].filter(([, n]) => n >= limite).map(([l]) => l)
  );
  if (repetidas.size === 0) return texto;

  return paginas
    .map((p) =>
      p
        .split('\n')
        .filter((l) => !repetidas.has(l.trim()))
        .join('\n')
    )
    .join('\f');
}

function contarPaginas(texto: string): number {
  // \f delimits pages in pdftotext's -layout output.
  const ff = texto.split('\f').length;
  return Math.max(1, ff);
}

async function extrairPdf(bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pleito-pdf-'));
  const pdfPath = join(dir, 'in.pdf');
  const txtPath = join(dir, 'out.txt');
  try {
    await writeFile(pdfPath, Buffer.from(bytes));
    // -layout preserves columns and keeps \f between pages.
    await execFileAsync('pdftotext', ['-layout', pdfPath, txtPath]);
    return await readFile(txtPath, 'utf-8');
  } catch {
    return '';
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** gunzip with an output ceiling — aborts inflation before OOM (zip-bomb). */
function gunzipComTeto(buf: Buffer): Buffer {
  try {
    return gunzipSync(buf, {
      maxOutputLength: MAX_DESCOMPRIMIDO_BYTES,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code =
      e && typeof e === 'object' && 'code' in e
        ? String((e as { code?: unknown }).code)
        : '';
    // Node throws RangeError ERR_BUFFER_TOO_LARGE when exceeding
    // maxOutputLength — an unambiguous zip-bomb signal.
    if (
      code === 'ERR_BUFFER_TOO_LARGE' ||
      /maxOutputLength|buffer larger than|too large/i.test(msg)
    ) {
      throw new EntradaGrandeDemaisError(
        `gzip inflaria além do cap (${msg})`
      );
    }
    throw e;
  }
}

/** Extracts the largest text/pdf file from a .zip and processes it. */
async function extrairZip(
  bytes: Uint8Array
): Promise<{ texto: string; pdfNativo: boolean }> {
  const dir = await unzipper.Open.buffer(Buffer.from(bytes));
  const candidatos = dir.files
    .filter((f) => f.type === 'File')
    .sort((a, b) => b.uncompressedSize - a.uncompressedSize);

  // Reject BEFORE inflating any entry: the largest `uncompressedSize`
  // declared in the header already exceeds the cap → zip-bomb (nothing
  // materialized).
  const maiorDeclarado = candidatos[0]?.uncompressedSize ?? 0;
  if (maiorDeclarado > MAX_DESCOMPRIMIDO_BYTES) {
    throw new EntradaGrandeDemaisError(
      `entry de zip declara uncompressedSize=${maiorDeclarado} > cap`
    );
  }

  for (const f of candidatos) {
    const buf = await f.buffer();
    const fmt = detectarFormato(new Uint8Array(buf));
    if (fmt === 'pdf') {
      const texto = await extrairPdf(new Uint8Array(buf));
      if (contarAlfanum(texto) >= MIN_ALFANUM) {
        return { texto, pdfNativo: true };
      }
    } else if (fmt === 'gzip') {
      const texto = gunzipComTeto(buf).toString('utf-8');
      if (contarAlfanum(texto) >= MIN_ALFANUM) {
        return { texto, pdfNativo: false };
      }
    } else if (fmt === 'texto') {
      const texto = buf.toString('utf-8');
      if (contarAlfanum(texto) >= MIN_ALFANUM) {
        return { texto, pdfNativo: false };
      }
    }
  }
  return { texto: '', pdfNativo: false };
}

/**
 * Preprocessor — zip/gz/pdf/texto → plain text + observed metadata. Runs
 * in the worker container (poppler/pdftotext installed); the local
 * environment also has `pdftotext` in /usr/bin. `fonte.ocr=true` when the
 * text comes out empty/too short (signals the need for OCR downstream).
 */
export class Preprocessor implements PreprocessorPort {
  async preprocessar(arquivo: ArquivoEntrada): Promise<TextoExtraido> {
    const { bytes, nomeArquivo, url } = arquivo;
    const formato = detectarFormato(bytes);

    // Decompressed size cap (anti zip-bomb). For raw text/pdf the buffer
    // itself IS the decompressed content — reject before touching it.
    // zip/gzip are checked at inflation (header / maxOutputLength).
    if (
      (formato === 'texto' || formato === 'pdf') &&
      bytes.length > MAX_DESCOMPRIMIDO_BYTES
    ) {
      throw new EntradaGrandeDemaisError(
        `${formato} cru tem ${bytes.length} bytes > cap`
      );
    }

    let texto = '';
    let pdfNativo = false;

    if (formato === 'zip') {
      const r = await extrairZip(bytes);
      texto = r.texto;
      pdfNativo = r.pdfNativo;
    } else if (formato === 'pdf') {
      texto = await extrairPdf(bytes);
      pdfNativo = true;
    } else if (formato === 'gzip') {
      // gunzipComTeto throws EntradaGrandeDemaisError if it would inflate
      // beyond the cap — propagate (do NOT mask as ''); other errors
      // become '' (corrupt gzip → falls to ocr downstream, legacy
      // behavior).
      try {
        texto = gunzipComTeto(Buffer.from(bytes)).toString('utf-8');
      } catch (e) {
        if (e instanceof EntradaGrandeDemaisError) throw e;
        texto = '';
      }
    } else {
      texto = Buffer.from(bytes).toString('utf-8');
    }

    const paginas = contarPaginas(texto);
    texto = normalizarHeaderRodape(texto);

    const ocr = contarAlfanum(texto) < MIN_ALFANUM;

    return {
      texto,
      fonte: {
        nomeArquivo,
        pdfNativo,
        ocr,
        paginas,
        url: url ?? null,
      },
    };
  }
}
