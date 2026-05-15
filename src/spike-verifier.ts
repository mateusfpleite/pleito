import 'dotenv/config';
import { google } from '@ai-sdk/google';
import { generateText } from 'ai';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Spike v2 do Norma Verifier.
 * Mudanças vs v1:
 *  - injeta data/norma-baseline.json como âncora autoritativa no prompt
 *  - gabarito da IN 05/2017 CORRIGIDO (não foi revogada; vigente c/ recepção
 *    supletiva — v1 herdou gabarito errado da 1ª verificação manual)
 *  - zona-cinzenta aceita {vigente|incerto} como correto; só "revogada" é erro
 */

type Caso = {
  id: string;
  descricao: string;
  numero: string;
  ano: number;
  escopoAlegadoNoEdital: string;
  gabarito: {
    existe: boolean;
    escopoReal: 'federal' | 'estadual' | 'municipal' | 'inexistente';
    status: 'vigente' | 'revogada' | 'inexistente';
    statusAceitos?: string[]; // zona-cinzenta: mais de um desfecho é seguro
    nota: string;
  };
};

const GABARITO: Caso[] = [
  {
    id: 'dec-8538-2015',
    descricao: 'Decreto Federal de tratamento favorecido a ME/EPP em licitações',
    numero: '8.538',
    ano: 2015,
    escopoAlegadoNoEdital: 'federal',
    gabarito: { existe: true, escopoReal: 'federal', status: 'vigente', nota: 'Alterado pelo Dec 10.273/2020, não revogado' },
  },
  {
    id: 'lei-9704-1995',
    descricao: 'Lei Federal nº 9.704 de 1995 citada como norma de licitação (ME/EPP)',
    numero: '9.704',
    ano: 1995,
    escopoAlegadoNoEdital: 'federal',
    gabarito: { existe: false, escopoReal: 'inexistente', status: 'inexistente', nota: 'Lei 9.704 real é 1998 (AGU), não licitação' },
  },
  {
    id: 'in-seges-05-2017',
    descricao: 'Instrução Normativa SEGES/MP nº 05 de 2017 (contratação de serviços continuados)',
    numero: '05',
    ano: 2017,
    escopoAlegadoNoEdital: 'federal',
    gabarito: {
      existe: true,
      escopoReal: 'federal',
      status: 'vigente',
      statusAceitos: ['vigente', 'incerto'],
      nota: 'CORRIGIDO: IN 98/2022 NÃO revogou expressamente; vigente c/ recepção supletiva sob 14.133. Zona-cinzenta — vigente ou incerto são seguros; revogada é erro',
    },
  },
  {
    id: 'in-slti-01-2010',
    descricao: 'Instrução Normativa SLTI/MP nº 01 de 19/01/2010 (sustentabilidade ambiental)',
    numero: '01',
    ano: 2010,
    escopoAlegadoNoEdital: 'federal',
    gabarito: { existe: true, escopoReal: 'federal', status: 'vigente', nota: 'Vigente, complementar ao Decreto 7.746/2012' },
  },
  {
    id: 'dec-5940-2006',
    descricao: 'Decreto Federal nº 5.940 de 2006 (coleta seletiva solidária)',
    numero: '5.940',
    ano: 2006,
    escopoAlegadoNoEdital: 'federal',
    gabarito: { existe: true, escopoReal: 'federal', status: 'revogada', nota: 'Revogado pelo Decreto 10.936/2022' },
  },
  {
    id: 'port-mte-1421-2014',
    descricao: 'Portaria MTE nº 1.421 de 12/09/2014 (Certidão de Débitos da Fiscalização do Trabalho)',
    numero: '1.421',
    ano: 2014,
    escopoAlegadoNoEdital: 'federal',
    gabarito: { existe: true, escopoReal: 'federal', status: 'revogada', nota: 'Revogada pela Portaria MTP nº 667/2021' },
  },
  {
    id: 'lei-6544-1989',
    descricao: 'Lei nº 6.544 de 22/11/1989 (estatuto de licitações), citada como norma federal',
    numero: '6.544',
    ano: 1989,
    escopoAlegadoNoEdital: 'federal',
    gabarito: { existe: true, escopoReal: 'estadual', status: 'vigente', nota: 'Lei ESTADUAL de São Paulo, não federal' },
  },
];

const VerdictSchema = z.object({
  existe: z.boolean(),
  escopoReal: z.enum(['federal', 'estadual', 'municipal', 'distrital', 'inexistente', 'incerto']),
  status: z.enum(['vigente', 'revogada', 'inexistente', 'incerto']),
  normaRevogadora: z.string().nullable(),
  confianca: z.enum(['alta', 'media', 'baixa']),
  fonteUsada: z.enum(['baseline-curada', 'web-grounding', 'ambas']),
  justificativa: z.string(),
});
type Verdict = z.infer<typeof VerdictSchema>;

function extractJson(text: string): unknown | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : text.match(/\{[\s\S]*\}/)?.[0];
  if (!raw) return null;
  try {
    return JSON.parse(raw.trim());
  } catch {
    return null;
  }
}

async function verificar(c: Caso, baselineJson: string): Promise<{ verdict: Verdict | null; sources: number }> {
  const prompt = `Você verifica o status de normas jurídicas brasileiras de licitação.

REGRA DE PRECEDÊNCIA:
1. Consulte primeiro a TABELA CURADA abaixo (fonte autoritativa interna, verificada manualmente). Se a norma constar nela (match por número/ano/tipo), use o status e a categoria de lá — NÃO contradiga a tabela com busca web.
2. Categoria "zona-cinzenta": status juridicamente disputado — responda status="incerto" (nunca afirme binário).
3. Categoria "citacao-suspeita": norma inexistente / escopo trocado / objeto trocado — responda existe=false ou escopoReal correto conforme a nota.
4. Só se a norma NÃO estiver na tabela, use busca web em fontes autoritativas (planalto, gov.br, in.gov.br, lexml, assembleias estaduais).

TABELA CURADA (data/norma-baseline.json):
${baselineJson}

NORMA A VERIFICAR:
${c.descricao}
Número: ${c.numero}/${c.ano} · escopo alegado no edital: ${c.escopoAlegadoNoEdital}

Responda terminando com bloco JSON:
\`\`\`json
{"existe": bool, "escopoReal": "federal|estadual|municipal|distrital|inexistente|incerto", "status": "vigente|revogada|inexistente|incerto", "normaRevogadora": "string|null", "confianca": "alta|media|baixa", "fonteUsada": "baseline-curada|web-grounding|ambas", "justificativa": "1-2 frases"}
\`\`\``;

  const { text, sources } = await generateText({
    model: google('gemini-2.5-flash'),
    tools: { google_search: google.tools.googleSearch({}) },
    prompt,
  });
  const parsed = extractJson(text);
  const v = VerdictSchema.safeParse(parsed);
  return { verdict: v.success ? v.data : null, sources: sources?.length ?? 0 };
}

function statusMatch(g: Caso['gabarito'], v: Verdict): boolean {
  if (!g.existe) return v.existe === false || v.status === 'inexistente';
  const aceitos = g.statusAceitos ?? [g.status];
  return aceitos.includes(v.status);
}
function escopoMatch(g: Caso['gabarito'], v: Verdict): boolean {
  if (g.escopoReal === 'inexistente') return v.existe === false || v.escopoReal === 'inexistente';
  return v.escopoReal === g.escopoReal;
}

async function main() {
  const baselineJson = await readFile(resolve('data/norma-baseline.json'), 'utf-8');
  console.log('SPIKE v2 — Norma Verifier COM baseline curada injetada\n' + '='.repeat(70));

  let statusOk = 0;
  let escopoOk = 0;
  let parseOk = 0;
  let usouBaseline = 0;
  let safeFail = 0;
  let dangerousFail = 0;

  for (const c of GABARITO) {
    process.stdout.write(`\n[${c.id}] ${c.numero}/${c.ano}\n`);
    try {
      const { verdict, sources } = await verificar(c, baselineJson);
      if (!verdict) {
        console.log('  PARSE FALHOU');
        continue;
      }
      parseOk++;
      if (verdict.fonteUsada === 'baseline-curada' || verdict.fonteUsada === 'ambas') usouBaseline++;
      const sOk = statusMatch(c.gabarito, verdict);
      const eOk = escopoMatch(c.gabarito, verdict);
      if (sOk) statusOk++;
      if (eOk) escopoOk++;
      const acerto = sOk && eOk;
      if (!acerto) {
        if (verdict.status === 'incerto' || verdict.confianca === 'baixa') safeFail++;
        else dangerousFail++;
      }
      console.log(`  gabarito: escopo=${c.gabarito.escopoReal} status=${c.gabarito.status}${c.gabarito.statusAceitos ? ' (aceitos: ' + c.gabarito.statusAceitos.join('|') + ')' : ''}`);
      console.log(`  verifier: escopo=${verdict.escopoReal} status=${verdict.status} conf=${verdict.confianca} fonte=${verdict.fonteUsada} (${sources} web)`);
      console.log(`  → status ${sOk ? 'OK' : 'ERRO'} · escopo ${eOk ? 'OK' : 'ERRO'} · ${acerto ? 'ACERTO' : verdict.status === 'incerto' || verdict.confianca === 'baixa' ? 'ERRO SEGURO' : 'ERRO PERIGOSO'}`);
      if (!acerto) console.log(`  justificativa: ${verdict.justificativa}`);
    } catch (err) {
      console.log(`  EXCEÇÃO: ${err instanceof Error ? err.message : err}`);
    }
  }

  const n = GABARITO.length;
  console.log('\n' + '='.repeat(70) + '\nRESULTADO v2\n' + '='.repeat(70));
  console.log(`Parse OK:          ${parseOk}/${n}`);
  console.log(`Usou baseline:     ${usouBaseline}/${n}`);
  console.log(`Status correto:    ${statusOk}/${n} (${((statusOk / n) * 100).toFixed(0)}%)`);
  console.log(`Escopo correto:    ${escopoOk}/${n} (${((escopoOk / n) * 100).toFixed(0)}%)`);
  console.log(`Erros SEGUROS:     ${safeFail}`);
  console.log(`Erros PERIGOSOS:   ${dangerousFail}`);
  console.log('\nBaseline v1 (sem tabela): 86% status, 1 erro perigoso (que era gabarito errado).');
  console.log('Critério v2: status ≥ 90% E erros perigosos = 0 E usou baseline em ≥ 6/7.');
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
