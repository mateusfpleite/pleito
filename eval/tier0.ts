/**
 * Gate Tier 0 — contenção ESTRUTURAL (SPEC §11a, §5 #2).
 *
 * Property-based, determinístico, custo zero: SEM LLM, SEM comparação com
 * corpus. As invariantes generalizam pra editais nunca vistos porque são
 * propriedades do confronto entre campos estruturados:
 *
 *   - `afirmacaoVigencia` (decisão do Drafter por lei citada, §5 #2)
 *   - `statusVerificado` (veredito do Norma Verifier por lei referenciada)
 *   - `matchNorma` (status determinístico do baseline curado)
 *
 * A CONTENÇÃO É ESTRUTURAL: o documento externo não contém NENHUMA prosa
 * livre de LLM. O modelo do Drafter não escreve texto — só emite seleções
 * estruturadas de achados já existentes na extração; o corpo do ofício é
 * montado 100% por TEMPLATES determinísticos do adapter. A garantia é a
 * AUSÊNCIA de prosa livre, não nenhum regex. Este Tier 0 é GATE DURO
 * redundante (defense-in-depth): qualquer violação = build falha.
 *
 * O scan léxico (checagem 2) é TRIPWIRE DEFENSIVO, NÃO o mecanismo de
 * contenção: se disparar, é bug estrutural (um template introduziu prosa de
 * status sem respaldo verificado) — nunca deveria disparar.
 *
 * 4 checagens (SPEC §11a):
 *   1. afirmacao-indevida / afirmacao-vigencia-proativa — confronto
 *      estrutural afirmacaoVigencia × statusVerificado (sem regex no gate
 *      primário).
 *   2. lexico-inconsistente — TRIPWIRE defensivo (não a garantia): prosa
 *      de revogação no markdown sem respaldo estruturado verificado = bug
 *      estrutural.
 *   3. baseline-divergente — statusVerificado VERIFICADO diverge da
 *      categoria determinística do baseline curado.
 *   4. zona-cinzenta-binarizada — lei zona-cinzenta jamais vira afirmação
 *      binária (revogada/vigente) no ofício.
 */

import type { EditalExtraction } from '../domain/schema.ts';
import type { OficioGerado } from '../domain/ports.ts';
import { matchNorma } from '../domain/norma-baseline.ts';
import { categoriaParaStatus } from '../domain/categoria-status.ts';

type StatusVerificado =
  EditalExtraction['leisReferenciadas'][number]['statusVerificado'];

/** Uma violação do gate. `tipo` é categórico; `detalhe` é diagnóstico. */
export type Violacao = {
  tipo:
    | 'afirmacao-indevida'
    | 'afirmacao-vigencia-proativa'
    | 'lexico-inconsistente'
    | 'baseline-divergente'
    | 'zona-cinzenta-binarizada';
  detalhe: string;
};

/**
 * Entrada do gate: o que o workflow da Phase 10 produz por análise — a
 * extração final (com `statusVerificado` preenchido pelo Norma Verifier) e o
 * ofício gerado pelo Drafter (ou `null` quando o gate B não disparou).
 */
export type AnaliseParaGate = {
  extracao: EditalExtraction;
  oficio: OficioGerado | null;
};

/**
 * TRIPWIRE léxico de (não)vigência — idêntico ao tripwire interno do Drafter
 * (SPEC §5 #2 / §11a). NÃO é o mecanismo de contenção (a contenção é a
 * ausência de prosa livre do modelo); é defesa-em-profundidade que NUNCA
 * deveria disparar. Expandido p/ paráfrases que vazaram em produção
 * (ab-rogad, derrogad, não subsiste, exaurid, etc.).
 */
const LEXICO_VIGENCIA =
  /revogad|ab-?rogad|derrogad|revogou-se|perdeu vig[êe]ncia|n[ãa]o subsiste|superad|exaurid|deixou de produzir efeitos|n[ãa]o vige|sem efic[áa]cia|n[ãa]o est[áa] (mais )?em vigor|deixou de viger|sem vig[êe]ncia|caducou/i;

/**
 * Categoria curada do baseline → `statusVerificado` esperado. Delega ao mapa
 * CANÔNICO ÚNICO `domain/categoria-status.ts` (MESMA fonte do Norma Verifier
 * — mapeamento de segurança, sem cópia divergível). Categoria desconhecida →
 * null (sem expectativa determinística → não acusa divergência).
 */
function categoriaParaStatusEsperado(
  categoria: string
): StatusVerificado | null {
  return categoriaParaStatus(categoria);
}

/** Referência textual curta de uma lei (para `detalhe`). */
function ref(numero: string | null, ano: number | null): string {
  return `${numero ?? '?'}/${ano ?? '?'}`;
}

/**
 * Lookup ROBUSTO de uma lei citada contra `leisReferenciadas` (espelha a
 * regra C2 do Drafter): `numero|ano` null OU chave não-única → não
 * identificável (nunca atribui status com segurança). Só match ÚNICO devolve
 * o `statusVerificado`.
 */
function lookupStatus(
  extracao: EditalExtraction,
  numero: string | null,
  ano: number | null
): { identificavel: boolean; statusVerificado: StatusVerificado | null } {
  if (numero === null || ano === null) {
    return { identificavel: false, statusVerificado: null };
  }
  const matches = extracao.leisReferenciadas.filter(
    (r) => r.numero === numero && r.ano === ano
  );
  if (matches.length !== 1) {
    return { identificavel: false, statusVerificado: null };
  }
  return {
    identificavel: true,
    statusVerificado: matches[0].statusVerificado,
  };
}

/**
 * CHECAGEM 1 — gate primário ESTRUTURAL (sem regex). Para cada lei citada:
 *  - `afirmacaoVigencia==='vigente'` → SEMPRE violação: o Drafter nunca deve
 *    afirmar vigência proativamente (SPEC §5 #2: só `nenhuma` ou `revogada`).
 *  - `afirmacaoVigencia==='revogada'` → exige a lei correspondente em
 *    `leisReferenciadas` (lookup robusto) com `statusVerificado==='revogada'`.
 *    Lei não identificável/ambígua, ou status ≠ revogada → violação.
 */
function checarGatePrimario(analise: AnaliseParaGate): Violacao[] {
  const { extracao, oficio } = analise;
  if (!oficio) return [];
  const violacoes: Violacao[] = [];

  for (const lei of oficio.leisCitadas) {
    if (lei.afirmacaoVigencia === 'vigente') {
      violacoes.push({
        tipo: 'afirmacao-vigencia-proativa',
        detalhe:
          `Lei ${ref(lei.numero, lei.ano)} com afirmacaoVigencia='vigente' ` +
          `— o Drafter nunca deve afirmar vigência proativamente (§5 #2: ` +
          `só 'nenhuma' ou 'revogada').`,
      });
      continue;
    }

    if (lei.afirmacaoVigencia === 'revogada') {
      const lk = lookupStatus(extracao, lei.numero, lei.ano);
      if (!lk.identificavel) {
        violacoes.push({
          tipo: 'afirmacao-indevida',
          detalhe:
            `Lei ${ref(lei.numero, lei.ano)} afirmada 'revogada' mas NÃO ` +
            `é identificável de forma única em leisReferenciadas ` +
            `(numero/ano null ou chave ambígua) — afirmação de revogação ` +
            `sobre lei não-identificável é indevida.`,
        });
        continue;
      }
      if (lk.statusVerificado !== 'revogada') {
        violacoes.push({
          tipo: 'afirmacao-indevida',
          detalhe:
            `Lei ${ref(lei.numero, lei.ano)} afirmada 'revogada' no ofício ` +
            `mas statusVerificado='${lk.statusVerificado}' na extração ` +
            `(exigido 'revogada').`,
        });
      }
    }
  }

  return violacoes;
}

/**
 * CHECAGEM 2 — TRIPWIRE DEFENSIVO (não o mecanismo de contenção). Como o
 * corpo do ofício é 100% templated e o único léxico de revogação permitido
 * vem do template de revogação (só sob lei revogada verificada), se o
 * markdown casa o léxico MAS nenhuma `leisCitadas` tem `afirmacaoVigencia===
 * 'revogada'` com `statusVerificado='revogada'` que o respalde → BUG
 * ESTRUTURAL (um template introduziu prosa de status indevida). Nunca
 * deveria disparar — a garantia é a ausência de prosa livre, não este scan.
 */
function checarBackstopLexico(analise: AnaliseParaGate): Violacao[] {
  const { extracao, oficio } = analise;
  if (!oficio) return [];
  if (!LEXICO_VIGENCIA.test(oficio.markdown)) return [];

  const temRespaldo = oficio.leisCitadas.some((lei) => {
    if (lei.afirmacaoVigencia !== 'revogada') return false;
    const lk = lookupStatus(extracao, lei.numero, lei.ano);
    return lk.identificavel && lk.statusVerificado === 'revogada';
  });

  if (temRespaldo) return [];

  return [
    {
      tipo: 'lexico-inconsistente',
      detalhe:
        'Markdown do ofício casa léxico de revogação mas NENHUMA lei ' +
        "citada tem afirmacaoVigencia='revogada' com statusVerificado=" +
        "'revogada' que respalde a prosa — inconsistência estrutural.",
    },
  ];
}

/**
 * CHECAGEM 3 — consistência baseline. Para cada lei de
 * `leisReferenciadas`: se `matchNorma` a classifica numa categoria de
 * status determinístico e o `statusVerificado` (JÁ VERIFICADO) diverge do
 * esperado pela categoria → divergência. `nao-verificado` NÃO é divergência
 * (extrações cruas/gold ainda não passaram pelo Verifier).
 */
function checarBaseline(analise: AnaliseParaGate): Violacao[] {
  const { extracao } = analise;
  const violacoes: Violacao[] = [];

  for (const lei of extracao.leisReferenciadas) {
    if (lei.statusVerificado === 'nao-verificado') continue;

    const hit = matchNorma({
      numero: lei.numero,
      ano: lei.ano,
      escopo: lei.escopo,
      tipoNorma: lei.tipoNorma,
    });
    if (!hit) continue;

    const esperado = categoriaParaStatusEsperado(hit.categoria);
    if (esperado === null) continue;

    if (lei.statusVerificado !== esperado) {
      violacoes.push({
        tipo: 'baseline-divergente',
        detalhe:
          `Lei ${ref(lei.numero, lei.ano)} casa baseline ` +
          `'${hit.entry.id}' (categoria '${hit.categoria}', via ` +
          `'${hit.via}') → esperado statusVerificado='${esperado}', ` +
          `obtido '${lei.statusVerificado}'.`,
      });
    }
  }

  return violacoes;
}

/**
 * CHECAGEM 4 — zona-cinzenta nunca vira binário. Lei cujo `matchNorma`
 * resolve em `zona-cinzenta` com `afirmacaoVigencia ∈ {revogada,vigente}`
 * no ofício → violação (status binário sobre norma juridicamente disputada).
 */
function checarZonaCinzenta(analise: AnaliseParaGate): Violacao[] {
  const { extracao, oficio } = analise;
  if (!oficio) return [];
  const violacoes: Violacao[] = [];

  // Index: numero|ano → leis referenciadas (para reconstruir escopo/tipo).
  for (const lei of oficio.leisCitadas) {
    if (lei.afirmacaoVigencia === 'nenhuma') continue;
    if (lei.numero === null || lei.ano === null) continue;

    const refs = extracao.leisReferenciadas.filter(
      (r) => r.numero === lei.numero && r.ano === lei.ano
    );
    const escopo = refs[0]?.escopo ?? 'federal';
    const tipoNorma = refs[0]?.tipoNorma ?? null;

    const hit = matchNorma({
      numero: lei.numero,
      ano: lei.ano,
      escopo,
      tipoNorma,
    });
    if (hit?.categoria === 'zona-cinzenta') {
      violacoes.push({
        tipo: 'zona-cinzenta-binarizada',
        detalhe:
          `Lei ${ref(lei.numero, lei.ano)} casa baseline ` +
          `'${hit.entry.id}' (zona-cinzenta) mas o ofício afirma ` +
          `afirmacaoVigencia='${lei.afirmacaoVigencia}' — status ` +
          `binário sobre norma juridicamente disputada é proibido.`,
      });
    }
  }

  return violacoes;
}

/**
 * GATE TIER 0. Roda as 4 checagens estruturais. `oficio:null` é válido (gate
 * B não disparou) — só as checagens que dependem do ofício são puladas; a
 * consistência baseline (checagem 3) ainda roda sobre a extração.
 *
 * Determinístico, sem efeitos colaterais, sem I/O, sem LLM.
 */
export function checarContencao(analise: AnaliseParaGate): {
  violacoes: Violacao[];
} {
  return {
    violacoes: [
      ...checarGatePrimario(analise),
      ...checarBackstopLexico(analise),
      ...checarBaseline(analise),
      ...checarZonaCinzenta(analise),
    ],
  };
}
