import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Spike do baseline matcher contra CORPUS REAL (nao casos inventados).
 * Valida o bloqueante #1 da plan-review: o falso-negativo do Gate A esta
 * fechado de verdade quando o input e o que o extractor produz de fato?
 * Fontes: fixtures/gold/{dombasilio,jaborandi,niteroi}.json (schema cheio,
 *   tem tipoNorma) + fixtures/gold/baserate-result.json allLaws (subset
 *   revogada, SEM tipoNorma). Corpus de regressão VERSIONADO (Phase 4):
 *   antes lia de output/ (gitignored); agora reproduzível pós-Phase 4.
 */

type BaselineEntry = {
  id: string;
  categoria: string;
  status?: string;
  match: { numero: string; ano: number; escopo: string; tipoNorma: string; aliases?: string[] };
  descricao: string;
};

function normalizarNumero(s: string): string {
  if (s == null) return '';
  const antesBarra = String(s).split('/')[0];
  const digitos = antesBarra.replace(/\D/g, '');
  const semZeros = digitos.replace(/^0+/, '');
  return semZeros.length ? semZeros : digitos;
}

const baseline = JSON.parse(
  readFileSync(resolve('data/norma-baseline.json'), 'utf-8')
) as { entries: BaselineEntry[] };

type MatchResult = { entry: BaselineEntry; via: 'estrito' | 'tolerante' | 'alias' } | null;

function matchNorma(input: {
  numero: string;
  ano: number | null;
  escopo: string;
  tipoNorma?: string | null;
}): MatchResult {
  const nIn = normalizarNumero(input.numero);
  for (const e of baseline.entries) {
    if (
      normalizarNumero(e.match.numero) === nIn &&
      e.match.ano === input.ano &&
      e.match.escopo === input.escopo &&
      (input.tipoNorma ? e.match.tipoNorma === input.tipoNorma : false)
    ) {
      return { entry: e, via: 'estrito' };
    }
  }
  for (const e of baseline.entries) {
    if (normalizarNumero(e.match.numero) === nIn && e.match.ano === input.ano) {
      return { entry: e, via: 'tolerante' };
    }
  }
  for (const e of baseline.entries) {
    for (const a of e.match.aliases ?? []) {
      if (input.numero && a.replace(/\D/g, '').includes(nIn) && nIn.length >= 3) {
        return { entry: e, via: 'alias' };
      }
    }
  }
  return null;
}

type RealLei = { numero: string; ano: number | null; escopo: string; tipoNorma?: string; descricao: string; origem: string };
const corpus: RealLei[] = [];
for (const f of ['dombasilio', 'jaborandi', 'niteroi']) {
  const d = JSON.parse(readFileSync(resolve(`fixtures/gold/${f}.json`), 'utf-8'));
  for (const l of d.leisReferenciadas ?? [])
    corpus.push({ numero: l.numero, ano: l.ano, escopo: l.escopo, tipoNorma: l.tipoNorma, descricao: l.descricao, origem: f });
}
const br = JSON.parse(readFileSync(resolve('fixtures/gold/baserate-result.json'), 'utf-8'));
for (const l of br.allLaws ?? [])
  corpus.push({ numero: l.numero, ano: l.ano, escopo: l.escopo, tipoNorma: undefined, descricao: l.descricao, origem: 'baserate:' + l.arquivo });

console.log('SPIKE MATCHER -- corpus real\n' + '='.repeat(64));
console.log(`Leis no corpus: ${corpus.length} (3 editais full + ${br.allLaws.length} baserate revogadas)`);

const formas = new Set(corpus.map((l) => String(l.numero)));
console.log(`\nFormatos crus de "numero" (amostra): ${[...formas].slice(0, 12).join(' - ')}`);
console.log(`Algum com ponto/barra/letra? ${[...formas].some((x) => /\D/.test(x)) ? 'SIM' : 'NAO (so digitos)'}`);

function baselineGT(numero: string, ano: number | null): BaselineEntry | undefined {
  const n = normalizarNumero(numero);
  return baseline.entries.find((e) => normalizarNumero(e.match.numero) === n && e.match.ano === ano);
}

let deveriaCasar = 0, estrito = 0, tolerante = 0, alias = 0, MISS = 0;
const misses: string[] = [];
const tipoDiverge: string[] = [];

for (const l of corpus) {
  const gt = baselineGT(l.numero, l.ano);
  if (!gt) continue;
  deveriaCasar++;
  const r = matchNorma(l);
  if (!r) {
    MISS++;
    misses.push(`${l.numero}/${l.ano} "${l.descricao.slice(0, 50)}" (${l.origem}) -> esperava ${gt.id}`);
  } else if (r.via === 'estrito') estrito++;
  else if (r.via === 'tolerante') {
    tolerante++;
    if (l.tipoNorma && l.tipoNorma !== gt.match.tipoNorma)
      tipoDiverge.push(`${l.numero}/${l.ano}: extractor=${l.tipoNorma} vs baseline=${gt.match.tipoNorma}`);
  } else alias++;
}

console.log('\n' + '='.repeat(64) + '\nGATE A -- norma da baseline citada no corpus real\n' + '='.repeat(64));
console.log(`Casos que DEVEM casar: ${deveriaCasar}`);
console.log(`  estrito:   ${estrito}`);
console.log(`  tolerante: ${tolerante}  (fallback numero+ano salvou -- LLM errou escopo/tipo)`);
console.log(`  alias:     ${alias}`);
console.log(`  MISS (falso-negativo real): ${MISS}`);

if (tipoDiverge.length) {
  console.log(`\nDivergencia tipoNorma extractor x baseline (${tipoDiverge.length}) -- por que o fallback e obrigatorio:`);
  tipoDiverge.slice(0, 8).forEach((t) => console.log('  ' + t));
}
if (misses.length) {
  console.log(`\nFALSOS-NEGATIVOS (Gate A nao pegaria):`);
  misses.forEach((m) => console.log('  ' + m));
}

let missSemNorm = 0;
for (const l of corpus) {
  const gt = baselineGT(l.numero, l.ano);
  if (!gt) continue;
  const casaSemNorm = baseline.entries.some(
    (e) => e.match.numero === String(l.numero) && e.match.ano === l.ano
  );
  if (!casaSemNorm) missSemNorm++;
}

// ---- direcao oposta: FALSO-POSITIVO ----
// (a) match via alias cujo numero+ano NAO bate (over-match do alias path)
// (b) match tolerante que atravessa escopo (estadual citado casando entry federal, etc.)
let fpAlias = 0;
let escopoCross = 0;
const fpDetalhe: string[] = [];
const crossDetalhe: string[] = [];
for (const l of corpus) {
  const r = matchNorma(l);
  if (!r) continue;
  const mesmoNumAno =
    normalizarNumero(r.entry.match.numero) === normalizarNumero(l.numero) && r.entry.match.ano === l.ano;
  if (!mesmoNumAno) {
    fpAlias++;
    fpDetalhe.push(`${l.numero}/${l.ano} "${l.descricao.slice(0, 45)}" casou ${r.entry.id} via ${r.via} (numero/ano NAO batem)`);
  } else if (r.via === 'tolerante' && r.entry.match.escopo !== l.escopo) {
    escopoCross++;
    crossDetalhe.push(`${l.numero}/${l.ano} escopo=${l.escopo} casou ${r.entry.id} (escopo baseline=${r.entry.match.escopo}, cat=${r.entry.categoria})`);
  }
}
console.log('\n' + '='.repeat(64) + '\nDIRECAO OPOSTA -- falso-positivo\n' + '='.repeat(64));
console.log(`Match via alias com numero/ano divergente (over-match ruim): ${fpAlias}`);
fpDetalhe.slice(0, 8).forEach((d) => console.log('  ' + d));
console.log(`\nMatch tolerante atravessando escopo: ${escopoCross}`);
console.log(`  (esperado/OK quando entry e citacao-suspeita -- existe justamente p/ pegar citacao errada)`);
crossDetalhe.slice(0, 10).forEach((d) => console.log('  ' + d));

console.log('\n' + '='.repeat(64) + '\nVEREDITO\n' + '='.repeat(64));
console.log(`Sem normalizar os 2 lados (o bug que o plano mascarava): ${missSemNorm}/${deveriaCasar} falsos-negativos`);
console.log(`Com normalizacao + fallback tolerante: ${MISS}/${deveriaCasar} falsos-negativos`);
console.log(`Criterio: MISS = 0 -> #1 fechado empiricamente. ${MISS === 0 ? 'FECHADO' : 'AINDA ABERTO'}`);
