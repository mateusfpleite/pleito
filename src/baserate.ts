import 'dotenv/config';
import { google } from '@ai-sdk/google';
import { generateObject } from 'ai';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod';

// Schema focado: só o que o estudo de base rate precisa.
const LeiSchema = z.object({
  descricao: z.string(),
  escopo: z.enum([
    'federal',
    'estadual',
    'municipal',
    'distrital',
    'constitucional',
    'infralegal',
  ]),
  tipoNorma: z.enum([
    'lei',
    'decreto',
    'portaria',
    'regulamento-interno',
    'deliberacao',
    'constituicao',
    'resolucao',
    'instrucao-normativa',
    'outro',
  ]),
  numero: z.string().nullable(),
  ano: z.number().nullable(),
  revogada: z.boolean(),
  // Confiança do próprio modelo na avaliação de vigência.
  confiancaRevogada: z.enum(['alta', 'media', 'baixa']),
  contextoNoEdital: z.string(),
});

const BaseRateSchema = z.object({
  municipio: z.string(),
  uf: z.string(),
  regimeJuridico: z.enum([
    'lei-14133',
    'lei-13303',
    'lei-8666',
    'lei-10520',
    'rdc',
    'misto',
    'outro',
  ]),
  leisReferenciadas: z.array(LeiSchema),
});

const SYSTEM_PROMPT = `Você é um especialista em legislação de licitações brasileiras. Extraia TODAS as leis, decretos, portarias, instruções normativas e resoluções citadas no edital.

Para cada norma:
- Identifique escopo (federal/estadual/municipal/distrital/constitucional/infralegal) e tipoNorma.
- revogada: true SOMENTE se a norma está revogada e foi citada anacronicamente (ex: Lei 8.666/93 ou Lei 10.520/02 num edital regido pela Lei 14.133/2021).
- confiancaRevogada: sua confiança REAL nessa avaliação de vigência. "alta" só para normas notórias e amplamente documentadas (ex: revogação da 8.666/93 pela 14.133/21). "baixa" para leis/decretos municipais obscuros cuja vigência você não tem como saber com segurança. "media" para casos intermediários. Seja honesto: se não sabe, é "baixa".
- regimeJuridico: o regime PRINCIPAL do edital.

Não invente normas. Liste apenas o que está citado no texto.`;

type LawRow = {
  arquivo: string;
  municipio: string;
  uf: string;
  descricao: string;
  escopo: string;
  numero: string | null;
  ano: number | null;
  revogada: boolean;
  confianca: string;
};

function classifyRevoked(escopo: string, numero: string | null): string {
  const n = (numero ?? '').replace(/\D/g, '');
  const notoria = n === '8666' || n === '10520';
  if (notoria) return 'federal-notoria';
  if (escopo === 'federal') return 'federal-outra';
  if (escopo === 'municipal') return 'municipal';
  if (escopo === 'estadual') return 'estadual';
  return escopo;
}

async function main() {
  const dir = resolve('fixtures/baserate');
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.txt'));
  } catch {
    console.error(`Diretório ${dir} não existe ainda. Rode o sourcing primeiro.`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error('Nenhum .txt em fixtures/baserate/. Sourcing ainda não terminou?');
    process.exit(1);
  }

  console.log(`Base rate study — ${files.length} editais\n${'='.repeat(60)}`);

  const allLaws: LawRow[] = [];
  let totalIn = 0;
  let totalOut = 0;
  let okCount = 0;

  for (const file of files.sort()) {
    const text = await readFile(join(dir, file), 'utf-8');
    if (text.trim().length < 500) {
      console.log(`SKIP ${file} (texto muito curto, ${text.length} chars)`);
      continue;
    }
    try {
      const { object, usage } = await generateObject({
        model: google('gemini-2.5-flash'),
        schema: BaseRateSchema,
        system: SYSTEM_PROMPT,
        prompt: `Extraia as normas citadas neste edital:\n\n${text}`,
      });
      totalIn += usage.inputTokens ?? 0;
      totalOut += usage.outputTokens ?? 0;
      okCount++;

      const revoked = object.leisReferenciadas.filter((l) => l.revogada);
      console.log(
        `\n${file}\n  ${object.municipio}/${object.uf} · regime ${object.regimeJuridico} · ${object.leisReferenciadas.length} normas · ${revoked.length} revogadas`
      );
      for (const l of revoked) {
        const cls = classifyRevoked(l.escopo, l.numero);
        const flag = cls === 'municipal' || cls === 'federal-outra' ? ' <<< VERIFICAR' : '';
        console.log(
          `    [${cls}] ${l.descricao} (${l.numero ?? '?'}/${l.ano ?? '?'}) conf=${l.confiancaRevogada}${flag}`
        );
        allLaws.push({
          arquivo: file,
          municipio: object.municipio,
          uf: object.uf,
          descricao: l.descricao,
          escopo: l.escopo,
          numero: l.numero,
          ano: l.ano,
          revogada: l.revogada,
          confianca: l.confiancaRevogada,
        });
      }
    } catch (err) {
      console.error(`ERRO ${file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Tabulação final
  console.log(`\n${'='.repeat(60)}\nTABULAÇÃO\n${'='.repeat(60)}`);
  console.log(`Editais processados com sucesso: ${okCount}/${files.length}`);
  console.log(`Total de findings revogada=true: ${allLaws.length}`);

  const byClass: Record<string, LawRow[]> = {};
  for (const l of allLaws) {
    const cls = classifyRevoked(l.escopo, l.numero);
    (byClass[cls] ??= []).push(l);
  }
  console.log('\nPor classe:');
  for (const [cls, rows] of Object.entries(byClass)) {
    const perigoso = cls === 'municipal' || cls === 'federal-outra';
    console.log(
      `  ${cls.padEnd(18)} ${rows.length}  ${perigoso ? '(CASO PERIGOSO — verificar manualmente)' : '(caso seguro)'}`
    );
  }

  const perigosos = allLaws.filter((l) => {
    const c = classifyRevoked(l.escopo, l.numero);
    return c === 'municipal' || c === 'federal-outra';
  });
  if (perigosos.length > 0) {
    console.log(`\n${'='.repeat(60)}\nCASOS PERIGOSOS PARA VERIFICAÇÃO MANUAL\n${'='.repeat(60)}`);
    for (const p of perigosos) {
      console.log(
        `${p.arquivo} | ${p.municipio}/${p.uf} | ${p.descricao} | ${p.numero}/${p.ano} | escopo=${p.escopo} | confiança do modelo=${p.confianca}`
      );
    }
  }

  const editaisComRevogada = new Set(allLaws.map((l) => l.arquivo)).size;
  console.log(`\n${'='.repeat(60)}\nBASE RATE\n${'='.repeat(60)}`);
  console.log(
    `Editais com ≥1 lei revogada citada: ${editaisComRevogada}/${okCount} (${((editaisComRevogada / okCount) * 100).toFixed(0)}%)`
  );
  const editaisComPerigoso = new Set(perigosos.map((l) => l.arquivo)).size;
  console.log(
    `Editais com ≥1 caso PERIGOSO (municipal/federal-outra revogada): ${editaisComPerigoso}/${okCount} (${((editaisComPerigoso / okCount) * 100).toFixed(0)}%)`
  );
  const custo = (totalIn / 1e6) * 0.3 + (totalOut / 1e6) * 2.5;
  console.log(`\nCusto total: $${custo.toFixed(4)} · ${okCount} editais · ${totalIn} in / ${totalOut} out`);

  await writeFile(
    resolve('output/baserate-result.json'),
    JSON.stringify({ okCount, total: files.length, allLaws, byClass: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, v.length])) }, null, 2)
  );
  console.log('\nDetalhe salvo em output/baserate-result.json');
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
