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

/** Mínimo de caracteres alfanuméricos p/ considerar a extração utilizável. */
const MIN_ALFANUM = 500;

/**
 * CARRY-FORWARD Phase 3+4 — cap de tamanho DESCOMPRIMIDO (anti zip-bomb).
 * Editais reais ficam muito abaixo de 50 MB (o maior do corpus < 5 MB).
 * Conteúdo descomprimido acima disso é rejeitado ANTES de ser
 * materializado — o worker transforma a rejeição em Job `erro` (mensagem
 * clara), nunca OOM. Aplica-se a: texto/pdf cru, gzip inflado, e cada
 * entry de zip (pelo `uncompressedSize` declarado no header).
 */
export const MAX_DESCOMPRIMIDO_BYTES = 50 * 1024 * 1024;

/** Erro de boundary: entrada excede o cap de descompressão (zip-bomb). */
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

/** Detecção por magic bytes (sem confiar na extensão do nome). */
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
 * Header/rodapé que se repete em toda página polui o texto e desperdiça
 * tokens. `pdftotext -layout` separa páginas com \f (form feed): linhas
 * idênticas presentes na maioria das páginas são removidas.
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
  // \f delimita páginas no -layout do pdftotext.
  const ff = texto.split('\f').length;
  return Math.max(1, ff);
}

async function extrairPdf(bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pleito-pdf-'));
  const pdfPath = join(dir, 'in.pdf');
  const txtPath = join(dir, 'out.txt');
  try {
    await writeFile(pdfPath, Buffer.from(bytes));
    // -layout preserva colunas e mantém \f entre páginas.
    await execFileAsync('pdftotext', ['-layout', pdfPath, txtPath]);
    return await readFile(txtPath, 'utf-8');
  } catch {
    return '';
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** gunzip com teto de saída — aborta a inflação antes de OOM (zip-bomb). */
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
    // Node lança RangeError ERR_BUFFER_TOO_LARGE ao passar de
    // maxOutputLength — sinal inequívoco de zip-bomb.
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

/** Extrai o maior arquivo de texto/pdf de um .zip e o processa. */
async function extrairZip(
  bytes: Uint8Array
): Promise<{ texto: string; pdfNativo: boolean }> {
  const dir = await unzipper.Open.buffer(Buffer.from(bytes));
  const candidatos = dir.files
    .filter((f) => f.type === 'File')
    .sort((a, b) => b.uncompressedSize - a.uncompressedSize);

  // Rejeita ANTES de inflar qualquer entry: o maior `uncompressedSize`
  // declarado no header já passa do cap → zip-bomb (não materializa nada).
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
 * Preprocessor — zip/gz/pdf/texto → texto plano + metadados observados.
 * Roda no worker container (poppler/pdftotext instalado); o ambiente local
 * também tem `pdftotext` em /usr/bin. `fonte.ocr=true` quando o texto sai
 * vazio/curto demais (sinaliza necessidade de OCR a jusante).
 */
export class Preprocessor implements PreprocessorPort {
  async preprocessar(arquivo: ArquivoEntrada): Promise<TextoExtraido> {
    const { bytes, nomeArquivo, url } = arquivo;
    const formato = detectarFormato(bytes);

    // Cap de tamanho descomprimido (anti zip-bomb). Para texto/pdf crus o
    // próprio buffer já É o conteúdo descomprimido — rejeita antes de
    // tocar. zip/gzip são checados na inflação (header / maxOutputLength).
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
      // gunzipComTeto lança EntradaGrandeDemaisError se inflaria além do
      // cap — propaga (NÃO mascarar como ''); outros erros viram '' (gzip
      // corrompido → cai p/ ocr a jusante, comportamento legado).
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
