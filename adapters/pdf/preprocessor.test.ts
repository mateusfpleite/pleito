import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync, deflateRawSync } from 'node:zlib';
import { Preprocessor, MAX_DESCOMPRIMIDO_BYTES } from './preprocessor.ts';
import type { ArquivoEntrada } from '../../domain/ports.ts';

/**
 * Preprocessor contra fixtures REAIS (determinístico — nada mocado).
 * (a) .txt direto → texto preserva o conteúdo do edital;
 * (b) .zip (fixtures/editais/jaborandi.zip, criado na Task 3.1) →
 *     descompacta e extrai o txt embutido (>1000 chars);
 * (c) entrada vazia → fonte.ocr = true (sinaliza necessidade de OCR).
 *
 * Detecção de formato por magic bytes: PK→zip, %PDF→pdf, \x1f\x8b→gz,
 * senão texto plano (UTF-8).
 */

function arquivo(
  nomeArquivo: string,
  bytes: Uint8Array
): ArquivoEntrada {
  return { nomeArquivo, bytes, url: null };
}

describe('Preprocessor', () => {
  const pre = new Preprocessor();

  it('(a) direct .txt: preserves the edital content', async () => {
    const bytes = readFileSync(resolve('fixtures/jaborandi.txt'));
    const r = await pre.preprocessar(
      arquivo('jaborandi.txt', new Uint8Array(bytes))
    );

    expect(r.texto).toContain('PREGÃO');
    expect(r.texto.length).toBeGreaterThan(1000);
    expect(r.fonte.ocr).toBe(false);
    expect(r.fonte.pdfNativo).toBe(false);
    expect(r.fonte.nomeArquivo).toBe('jaborandi.txt');
    expect(r.fonte.paginas).toBeGreaterThanOrEqual(1);
  });

  it('(b) .zip: decompresses and extracts the embedded txt (>1000 chars)', async () => {
    const bytes = readFileSync(
      resolve('fixtures/editais/jaborandi.zip')
    );
    const r = await pre.preprocessar(
      arquivo('jaborandi.zip', new Uint8Array(bytes))
    );

    expect(r.texto.length).toBeGreaterThan(1000);
    expect(r.texto).toContain('PREGÃO');
    expect(r.fonte.ocr).toBe(false);
  });

  it('(c) empty input: fonte.ocr = true', async () => {
    const r = await pre.preprocessar(
      arquivo('vazio.txt', new Uint8Array(0))
    );

    expect(r.fonte.ocr).toBe(true);
    expect(r.texto.length).toBeLessThan(500);
  });

  it('short text (<500 alphanumeric chars): fonte.ocr = true', async () => {
    const r = await pre.preprocessar(
      arquivo('curto.txt', new TextEncoder().encode('PDF escaneado.'))
    );

    expect(r.fonte.ocr).toBe(true);
  });

  /**
   * CARRY-FORWARD Phase 3+4 — proteção zip-bomb. O cap de tamanho
   * descomprimido evita OOM com entrada maliciosa. Rejeita ANTES de
   * materializar o conteúdo; o job vira `erro` (o worker captura) com
   * mensagem clara — nunca derruba o processo.
   */
  it('plain text above the decompressed cap: rejects (no OOM)', async () => {
    const grande = new Uint8Array(MAX_DESCOMPRIMIDO_BYTES + 1024);
    grande.fill(65); // 'A'
    await expect(
      pre.preprocessar(arquivo('grande.txt', grande))
    ).rejects.toThrow(/limite.*descomprimid|tamanho|zip-bomb/i);
  });

  it('gzip that decompresses above the cap: rejects (zip-bomb)', async () => {
    // Payload comprimido minúsculo, descomprimido >> cap (bomba clássica).
    const enorme = Buffer.alloc(MAX_DESCOMPRIMIDO_BYTES + 4096, 0x41);
    const bomba = gzipSync(enorme);
    expect(bomba.length).toBeLessThan(100_000); // de fato uma bomba
    await expect(
      pre.preprocessar(
        arquivo('bomba.gz', new Uint8Array(bomba))
      )
    ).rejects.toThrow(/limite.*descomprimid|zip-bomb/i);
  });

  it('zip with entry uncompressedSize above the cap: rejects', async () => {
    // ZIP mínimo: 1 entry deflate; uncompressedSize DECLARADO > cap mas
    // payload comprimido minúsculo. O Preprocessor rejeita pelo header,
    // sem inflar (rejeita antes de processar — não OOM).
    const conteudo = Buffer.alloc(64, 0x41);
    const comprimido = deflateRawSync(conteudo);
    const nome = Buffer.from('bomb.txt', 'ascii');
    const crc = 0; // não validado pelo unzipper p/ o teste do header
    const tamanhoMentira = MAX_DESCOMPRIMIDO_BYTES + 999_999;

    const lfh = Buffer.alloc(30 + nome.length);
    lfh.writeUInt32LE(0x04034b50, 0); // local file header sig
    lfh.writeUInt16LE(20, 4); // version
    lfh.writeUInt16LE(0, 6); // flags
    lfh.writeUInt16LE(8, 8); // method = deflate
    lfh.writeUInt16LE(0, 10); // time
    lfh.writeUInt16LE(0, 12); // date
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(comprimido.length, 18);
    lfh.writeUInt32LE(tamanhoMentira >>> 0, 22); // uncompressed (mentira)
    lfh.writeUInt16LE(nome.length, 26);
    lfh.writeUInt16LE(0, 28);
    nome.copy(lfh, 30);

    const cdh = Buffer.alloc(46 + nome.length);
    cdh.writeUInt32LE(0x02014b50, 0); // central dir sig
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(8, 10); // deflate
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(comprimido.length, 20);
    cdh.writeUInt32LE(tamanhoMentira >>> 0, 24);
    cdh.writeUInt16LE(nome.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(0, 42); // offset do LFH
    nome.copy(cdh, 46);

    const offsetCd = lfh.length + comprimido.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cdh.length, 12);
    eocd.writeUInt32LE(offsetCd, 16);
    eocd.writeUInt16LE(0, 20);

    const zip = Buffer.concat([lfh, comprimido, cdh, eocd]);
    await expect(
      pre.preprocessar(arquivo('bomb.zip', new Uint8Array(zip)))
    ).rejects.toThrow(/limite.*descomprimid|zip-bomb|uncompressed/i);
  });
});
