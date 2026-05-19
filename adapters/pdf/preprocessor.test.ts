import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Preprocessor } from './preprocessor.ts';
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

  it('(a) .txt direto: preserva o conteúdo do edital', async () => {
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

  it('(b) .zip: descompacta e extrai o txt embutido (>1000 chars)', async () => {
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

  it('(c) entrada vazia: fonte.ocr = true', async () => {
    const r = await pre.preprocessar(
      arquivo('vazio.txt', new Uint8Array(0))
    );

    expect(r.fonte.ocr).toBe(true);
    expect(r.texto.length).toBeLessThan(500);
  });

  it('texto curto (<500 chars alfanum): fonte.ocr = true', async () => {
    const r = await pre.preprocessar(
      arquivo('curto.txt', new TextEncoder().encode('PDF escaneado.'))
    );

    expect(r.fonte.ocr).toBe(true);
  });
});
