import 'dotenv/config';
import { google } from '@ai-sdk/google';
import { generateObject } from 'ai';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EditalExtractionSchema } from './schema.ts';

const SYSTEM_PROMPT = `Você é um especialista em análise de editais de licitação brasileiros.
Sua tarefa é extrair informações estruturadas do edital fornecido, seguindo rigorosamente o schema.

INSTRUÇÕES CRÍTICAS:

1. Sempre leia o CORPO do edital, não apenas a capa. A capa pode ter erros de copy-paste (objeto trocado, valores divergentes). Verifique no corpo, preâmbulo e termo de referência.

2. Se objetoCapa diverge de objetoCorpo, preencha ambos e marque uma incoerência tipo "objeto-divergente" com severidade "alta". Se forem iguais, deixe objetoCapa como null.

3. Se o valor estimado divergir entre peças (ex: capa vs TR), marque incoerência tipo "valor-divergente".

4. Lei revogada citada anacronicamente (ex: Lei 8.666/93 ou Lei 10.520/02 num edital regido pela Lei 14.133/2021) deve ter revogada: true.

5. Se um anexo é referenciado mas não está presente no texto fornecido (ex: TR mencionado mas conteúdo ausente), marque presenteNoArquivo: false.

6. Identifique trechos AMBÍGUOS (brechas/aberturas) que pedem leitura humana cuidadosa — exemplos: "complexidade tecnológica e operacional equivalente" sem quantitativo, "a critério da Administração", prazos com placeholders ("XX dias"), valor "sigiloso" sem orientação clara.

7. Para itens licitados (urnas, mortalha, tanatopraxia, etc.), classifique por tipo e público-alvo. Se o TR não está presente, deixe itensLicitados como array vazio.

8. NÃO invente campos. Use null onde o edital não informar.

9. SEMPRE preencha leisReferenciadas com TODAS as leis/decretos/portarias/INs citadas no texto, mesmo as comuns. Para cada uma, identifique tipoNorma corretamente (lei/decreto/portaria/regulamento-interno/instrucao-normativa/etc).

10. regimeJuridico é o regime PRINCIPAL do edital (não as leis subsidiárias). Ex: empresa estatal usa "lei-13303" mesmo citando outras leis.

11. Datas devem estar em formato ISO 8601 (YYYY-MM-DD ou YYYY-MM-DDTHH:mm:ss-03:00 com timezone se disponível).

12. JSON deve sempre validar contra o schema.`;

const FIXTURES = [
  { name: 'dombasilio', path: 'fixtures/dombasilio.txt' },
  { name: 'jaborandi', path: 'fixtures/jaborandi.txt' },
  { name: 'niteroi', path: 'fixtures/niteroi.txt' },
];

type Result = {
  name: string;
  ms: number;
  tokensIn: number;
  tokensOut: number;
  ok: boolean;
  error?: string;
};

async function extractOne(name: string, path: string): Promise<Result> {
  console.log(`\n=== ${name.toUpperCase()} ===`);
  const text = await readFile(resolve(path), 'utf-8');
  console.log(`Chars: ${text.length} (~${Math.round(text.length / 4)} tokens estimados)`);

  const start = Date.now();
  try {
    const result = await generateObject({
      model: google('gemini-2.5-flash'),
      schema: EditalExtractionSchema,
      system: SYSTEM_PROMPT,
      prompt: `Extraia as informações estruturadas deste edital de licitação:\n\n---INÍCIO DO EDITAL---\n${text}\n---FIM DO EDITAL---`,
    });
    const ms = Date.now() - start;
    const { object, usage } = result;

    console.log(`Tempo: ${(ms / 1000).toFixed(1)}s`);
    console.log(
      `Tokens: ${usage.inputTokens ?? '?'} in / ${usage.outputTokens ?? '?'} out`
    );

    const outPath = resolve(`output/${name}.json`);
    await writeFile(outPath, JSON.stringify(object, null, 2));
    console.log(`Saved: ${outPath}`);

    // Sanity check rápido
    console.log(`\nMunicípio: ${object.municipio}/${object.uf}`);
    console.log(`Ente: ${object.ente.tipo} - ${object.ente.razaoSocial}`);
    console.log(`Modalidade: ${object.modalidade} | Regime: ${object.regimeJuridico}`);
    console.log(`Objeto (corpo): ${object.objetoCorpo.slice(0, 120)}...`);
    if (object.objetoCapa) {
      console.log(`Objeto (capa): ${object.objetoCapa.slice(0, 120)}...`);
      console.log(`  ⚠ DIVERGÊNCIA CAPA vs CORPO detectada`);
    }
    console.log(
      `Valor: ${
        object.valor.sigiloso
          ? 'SIGILOSO'
          : object.valor.estimado !== null
          ? `R$ ${object.valor.estimado.toLocaleString('pt-BR')}`
          : 'null'
      } (procedência: ${object.valor.procedencia})`
    );
    console.log(`Critério: ${object.criterioJulgamento} por ${object.agrupamento}`);
    console.log(`Leis referenciadas: ${object.leisReferenciadas.length}`);
    console.log(
      `  Revogadas: ${object.leisReferenciadas.filter((l) => l.revogada).length}`
    );
    console.log(
      `  Municipais: ${object.leisReferenciadas.filter((l) => l.escopo === 'municipal').length}`
    );
    console.log(`Itens licitados: ${object.itensLicitados.length}`);
    console.log(`Anexos: ${object.anexos.length} (${object.anexos.filter(a => !a.presenteNoArquivo).length} ausentes)`);
    console.log(`Incoerências: ${object.incoerencias.length}`);
    object.incoerencias.forEach((i) =>
      console.log(`  [${i.severidade}] ${i.tipo}: ${i.descricao.slice(0, 80)}...`)
    );
    console.log(`Trechos ambíguos: ${object.trechosAmbiguos.length}`);

    return {
      name,
      ms,
      tokensIn: usage.inputTokens ?? 0,
      tokensOut: usage.outputTokens ?? 0,
      ok: true,
    };
  } catch (err) {
    const ms = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ FALHOU: ${msg}`);
    return { name, ms, tokensIn: 0, tokensOut: 0, ok: false, error: msg };
  }
}

async function main() {
  console.log('=================================================');
  console.log('Validação schema v2 — Gemini 2.5 Flash');
  console.log('=================================================');

  const results: Result[] = [];
  for (const f of FIXTURES) {
    const r = await extractOne(f.name, f.path);
    results.push(r);
  }

  console.log('\n=================================================');
  console.log('RESUMO');
  console.log('=================================================');
  let totalIn = 0;
  let totalOut = 0;
  for (const r of results) {
    const status = r.ok ? '✓' : '✗';
    console.log(
      `${status} ${r.name.padEnd(12)} ${(r.ms / 1000).toFixed(1)}s  ${r.tokensIn} in / ${r.tokensOut} out`
    );
    totalIn += r.tokensIn;
    totalOut += r.tokensOut;
  }
  // Pricing Gemini 2.5 Flash: $0.30/M in, $2.50/M out
  const costIn = (totalIn / 1_000_000) * 0.3;
  const costOut = (totalOut / 1_000_000) * 2.5;
  console.log(
    `\nCusto total estimado: $${(costIn + costOut).toFixed(4)} (in: $${costIn.toFixed(4)}, out: $${costOut.toFixed(4)})`
  );
  console.log(`Média por edital: $${((costIn + costOut) / FIXTURES.length).toFixed(4)}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
