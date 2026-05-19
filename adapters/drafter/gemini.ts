/**
 * Drafter adapter — Gemini Flash via Vercel AI SDK (`generateObject`).
 *
 * Pipeline step 7 (SPEC §4 / §5 #2). É a fase MAIS crítica de segurança do
 * produto: o ofício sai da Zelo para uma comissão de licitação externa. Se
 * uma afirmação de revogação NÃO verificada vazar, o dano à credibilidade é
 * irreversível (SPEC §5).
 *
 * CONTENÇÃO ESTRUTURAL REAL — princípio: ZERO prosa livre do modelo no
 * ofício externo (SPEC §5 #2):
 *
 *   1. O modelo do Drafter NÃO escreve NENHUM texto que entre no documento.
 *      Ele emite SOMENTE decisões estruturadas:
 *        - `tipo` ∈ {esclarecimento, impugnacao};
 *        - `selecoes[]`: cada item referencia um achado JÁ EXISTENTE na
 *          extração por `{fonte, indice}` — `extracao.incoerencias[]`,
 *          `extracao.trechosAmbiguos[]` ou `extracao.pontosDeAtencao[]`. O
 *          modelo escolhe O QUE levantar e a ORDEM, NÃO REDIGE;
 *        - `leisCitadas[]` com `afirmacaoVigencia` (já estrutural, e ainda
 *          sobrescrito pelo lookup robusto / statusVerificado).
 *      NÃO existe mais `pontos:[{titulo,argumento}]` (texto livre removido do
 *      schema do modelo).
 *   2. O corpo do ofício é montado 100% por TEMPLATES determinísticos deste
 *      adapter, keyed pelo TIPO ESTRUTURADO do achado selecionado:
 *        - incoerência → template por `incoerencia.tipo` (enum). Para
 *          `lei-revogada` roteia pela lógica de vigência-template (só afirma
 *          revogação se a lei tem match ÚNICO + statusVerificado='revogada';
 *          senão pergunta neutra);
 *        - trechoAmbiguo → template "ponto que demanda esclarecimento"
 *          referenciando `secaoOndeAparece` (campo estruturado curto);
 *        - pontoDeAtencao → template por `categoria` (enum).
 *      Slots: APENAS campos ESTRUTURADOS não-jurídico-de-status (nome de
 *      seção). NUNCA strings livres de `descricao`/`porQueAmbiguo`/etc.
 *   3. Nenhuma string livre produzida por LLM (extractor OU drafter)
 *      descrevendo status legal chega ao documento. Todo caminho segue o
 *      estilo do "neutro determinístico" + as frases-template de revogação
 *      quando (e só quando) statusVerificado='revogada' e match único.
 *   4. BACKSTOP LÉXICO = TRIPWIRE defensivo, NÃO a garantia. A garantia é a
 *      AUSÊNCIA de prosa livre (não existe canal por onde o modelo escreva
 *      texto no documento). O scan é mantido no adapter e no Tier 0: se
 *      disparar, é BUG ESTRUTURAL → hard fail (lança). Ele NÃO "filtra" — não
 *      há o que filtrar.
 *   5. LOOKUP ROBUSTO (C2): `numero===null`/`ano===null` nunca é match
 *      confiável; chave `numero|ano` não-única em `leisReferenciadas` também
 *      não → lei tratada como não-identificável (`nenhuma`/neutro). Asserção
 *      de revogação só com match ÚNICO + `statusVerificado==='revogada'`.
 *
 * CONTRATO (`DrafterPort`):
 *   redigir(e: EditalExtraction): Promise<OficioGerado | null>
 *   - `null` quando o gate B canônico não dispara. Nesse caso o modelo nem
 *     é chamado.
 *   - `OficioGerado = { tipo, markdown, leisCitadas: LeiNoOficio[] }`.
 *     `markdown` é SEMPRE montado 100% por este adapter via templates.
 */

import { generateObject } from 'ai';
import { google } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import type { EditalExtraction } from '../../domain/schema.ts';
import type {
  DrafterPort,
  OficioGerado,
  LeiNoOficio,
} from '../../domain/ports.ts';
import { getConfig } from '../../infrastructure/config.ts';
import { montarPrompt, SYSTEM_PROMPT } from './prompt.ts';

/**
 * Schema do que o modelo propõe. SEM nenhum campo de texto livre. O modelo
 * só DECIDE: o tipo do ofício, QUAIS achados estruturados levantar (por
 * referência índice/fonte) e em que ORDEM, e a decisão estrutural por lei.
 * `.strip()` (default do Zod) descarta quaisquer campos extras que o modelo
 * tente inventar (ex.: `argumento`, `textoLivre`) — eles nunca chegam ao
 * adapter, logo nunca ao documento.
 */
const OficioPropostoSchema = z.object({
  tipo: z.enum(['esclarecimento', 'impugnacao']),
  selecoes: z.array(
    z.object({
      fonte: z.enum(['incoerencia', 'trechoAmbiguo', 'pontoDeAtencao']),
      indice: z.number().int().nonnegative(),
    })
  ),
  leisCitadas: z.array(
    z.object({
      numero: z.string().nullable(),
      ano: z.number().nullable(),
      afirmacaoVigencia: z.enum(['nenhuma', 'revogada', 'vigente']),
    })
  ),
});

/**
 * TRIPWIRE léxico de (não)vigência — NÃO é o mecanismo de contenção. A
 * contenção é a ausência de prosa livre do modelo. Se este regex casar o
 * markdown final é porque um TEMPLATE deste adapter introduziu o léxico
 * indevidamente → BUG ESTRUTURAL, lança. Expandido p/ paráfrases que
 * vazaram em produção (ab-rogad, derrogad, não subsiste, exaurid, etc.).
 */
const LEXICO_VIGENCIA =
  /revogad|ab-?rogad|derrogad|revogou-se|perdeu vig[êe]ncia|n[ãa]o subsiste|superad|exaurid|deixou de produzir efeitos|n[ãa]o vige|sem efic[áa]cia|n[ãa]o est[áa] (mais )?em vigor|deixou de viger|sem vig[êe]ncia|caducou/i;

/** True se a string contém léxico de (não)vigência (tripwire). */
function temLexicoVigencia(s: string): boolean {
  return LEXICO_VIGENCIA.test(s);
}

/**
 * Gate B canônico (SPEC §4 step 6 / Phase 10): só há ofício a redigir se a
 * extração traz incoerência ≥ média OU trecho ambíguo OU pontoDeAtencao com
 * recomendaManifestacao. Incoerência `severidade:'baixa'` SOZINHA não dispara.
 */
function temAlgoAQuestionar(e: EditalExtraction): boolean {
  const incoerenciaRelevante = e.incoerencias.some(
    (i) => i.severidade === 'alta' || i.severidade === 'media'
  );
  return (
    incoerenciaRelevante ||
    e.trechosAmbiguos.length > 0 ||
    e.pontosDeAtencao.some((p) => p.recomendaManifestacao)
  );
}

/** Referência textual neutra de uma lei (sem afirmar (não)vigência). */
function refLei(numero: string | null, ano: number | null): string {
  const n = numero ? `nº ${numero}` : null;
  const a = ano ? `/${ano}` : null;
  return [n, a].filter(Boolean).join('') || 'invocada no edital';
}

/** Frase-pergunta TEMPLATE neutra sobre uma norma — NUNCA afirma vigência. */
function perguntaNeutraNorma(l: LeiNoOficio): string {
  return (
    `**Norma aplicável.** Quanto à norma ${refLei(l.numero, l.ano)}, ` +
    `solicita-se confirmação sobre a norma efetivamente aplicável e o ` +
    `exato alcance das exigências dela decorrentes para fins deste certame.`
  );
}

/**
 * Frase-afirmação TEMPLATE de revogação — única forma de afirmar revogação
 * no ofício. Só é emitida quando o match foi ÚNICO e statusVerificado=
 * 'revogada'. É o ÚNICO ponto onde o léxico de vigência é introduzido, de
 * forma 100% controlada pelo adapter (não pelo modelo).
 */
function templateRevogada(l: LeiNoOficio, fonte: string | null): string {
  const fonteRef = fonte ? `conforme ${fonte}` : 'conforme verificação realizada';
  return (
    `**Norma revogada.** A norma ${refLei(l.numero, l.ano)} encontra-se ` +
    `revogada, ${fonteRef}. Solicita-se esclarecimento sobre qual o regime ` +
    `jurídico efetivamente aplicável ao presente certame e, sendo o caso, a ` +
    `devida retificação do instrumento convocatório.`
  );
}

const FECHO_NEUTRO =
  'Solicita-se esclarecimento e, sendo o caso, a devida retificação do ' +
  'instrumento convocatório.';

/**
 * Templates determinísticos por TIPO de incoerência (enum do schema). NUNCA
 * interpolam `incoerencia.descricao` (prosa livre do extractor). O tipo
 * `lei-revogada` é tratado FORA daqui (roteia pela lógica de vigência).
 */
function templateIncoerencia(
  tipo: EditalExtraction['incoerencias'][number]['tipo']
): string {
  switch (tipo) {
    case 'valor-divergente':
      return (
        `**Divergência de valor.** Constatou-se divergência entre os ` +
        `valores informados no instrumento convocatório. ${FECHO_NEUTRO}`
      );
    case 'objeto-divergente':
      return (
        `**Divergência de objeto.** Constatou-se divergência na ` +
        `descrição do objeto entre as peças do instrumento convocatório. ` +
        `${FECHO_NEUTRO}`
      );
    case 'numeracao-quebrada':
      return (
        `**Inconsistência de numeração.** Constatou-se inconsistência na ` +
        `numeração de itens/cláusulas do instrumento convocatório. ` +
        `${FECHO_NEUTRO}`
      );
    case 'lei-revogada':
      // Tratado pelo caminho de vigência (frase-template de revogação só se
      // statusVerificado='revogada'; senão pergunta neutra). Aqui é o
      // fallback NEUTRO quando não há lei verificada-revogada a vincular.
      return (
        `**Norma aplicável ao certame.** Identificou-se questão quanto ao ` +
        `regime jurídico/normas invocadas no instrumento convocatório. ` +
        `Solicita-se confirmação sobre a norma efetivamente aplicável e, ` +
        `sendo o caso, a devida retificação do instrumento convocatório.`
      );
    case 'outro':
    default:
      return (
        `**Divergência identificada.** Constatou-se divergência no ` +
        `instrumento convocatório que demanda esclarecimento. ` +
        `${FECHO_NEUTRO}`
      );
  }
}

/**
 * Template determinístico para trecho ambíguo. Único slot: `secaoOndeAparece`
 * (campo ESTRUTURADO curto — nome de seção, não prosa de status). Ainda assim
 * passa pelo tripwire por garantia (se uma seção tiver léxico, neutraliza).
 */
function templateTrechoAmbiguo(secaoOndeAparece: string): string {
  const secao = temLexicoVigencia(secaoOndeAparece)
    ? 'seção indicada na análise'
    : secaoOndeAparece;
  return (
    `**Ponto que demanda esclarecimento (${secao}).** Identificou-se ` +
    `ambiguidade de redação no instrumento convocatório que dificulta a ` +
    `correta formulação das propostas. Solicita-se esclarecimento quanto ` +
    `à redação do referido ponto.`
  );
}

/** Template determinístico por `categoria` do pontoDeAtencao (enum). */
function templatePontoDeAtencao(
  categoria: EditalExtraction['pontosDeAtencao'][number]['categoria']
): string {
  switch (categoria) {
    case 'financeiro':
      return (
        `**Ponto de atenção (financeiro).** Identificou-se exigência de ` +
        `natureza financeira que demanda esclarecimento quanto à sua ` +
        `extensão e fundamentação. ${FECHO_NEUTRO}`
      );
    case 'operacional':
      return (
        `**Ponto de atenção (operacional).** Identificou-se exigência ` +
        `operacional que demanda esclarecimento quanto à sua exequibilidade ` +
        `e fundamentação. ${FECHO_NEUTRO}`
      );
    case 'juridico':
      return (
        `**Ponto de atenção (jurídico).** Identificou-se exigência de ` +
        `natureza jurídica que demanda esclarecimento quanto à sua ` +
        `legalidade e fundamentação. ${FECHO_NEUTRO}`
      );
    case 'competitivo':
    default:
      return (
        `**Ponto de atenção (competitivo).** Identificou-se exigência que ` +
        `pode restringir a competitividade do certame e demanda ` +
        `esclarecimento quanto à sua fundamentação. ${FECHO_NEUTRO}`
      );
  }
}

/**
 * Resultado do lookup robusto de uma lei proposta contra
 * `e.leisReferenciadas` (C2). `revogadaVerificada` só é `true` quando o
 * match é ÚNICO e `statusVerificado==='revogada'`.
 */
type Lookup =
  | { tipo: 'inventada' }
  | { tipo: 'naoIdentificavel' }
  | {
      tipo: 'unica';
      revogadaVerificada: boolean;
      fonteVerificacao: string | null;
    };

/**
 * Lookup ROBUSTO (C2). `numero===null`/`ano===null` → não-identificável;
 * chave não-única → não-identificável; chave presente mas ausente de
 * leisReferenciadas → inventada (descarta); só match ÚNICO +
 * `statusVerificado==='revogada'` permite afirmar revogação.
 */
function lookupLei(
  e: EditalExtraction,
  numero: string | null,
  ano: number | null
): Lookup {
  if (numero === null || ano === null) {
    return { tipo: 'naoIdentificavel' };
  }
  const matches = e.leisReferenciadas.filter(
    (r) => r.numero === numero && r.ano === ano
  );
  if (matches.length === 0) {
    return { tipo: 'inventada' };
  }
  if (matches.length > 1) {
    return { tipo: 'naoIdentificavel' };
  }
  const m = matches[0];
  return {
    tipo: 'unica',
    revogadaVerificada: m.statusVerificado === 'revogada',
    fonteVerificacao: m.fonteVerificacao,
  };
}

/** Cabeçalho/rodapé do ofício (formato fiel ao modelo de Pariconha). */
function montarMarkdown(
  e: EditalExtraction,
  tipo: OficioGerado['tipo'],
  pontos: string[]
): string {
  const corpo =
    pontos.length > 0
      ? pontos.map((p, i) => `${i + 1}. ${p}`).join('\n\n')
      : 'Solicita-se esclarecimento sobre os pontos identificados no edital.';

  return [
    `À Comissão de Licitação / Sr. Pregoeiro`,
    `${e.ente.razaoSocial} — ${e.municipio}/${e.uf}`,
    ``,
    `**Assunto:** Pedido de ${
      tipo === 'impugnacao' ? 'impugnação' : 'esclarecimento'
    } — ${e.modalidade} nº ${e.numero}.`,
    ``,
    `Prezados Senhores,`,
    ``,
    `A empresa interessada em participar do certame em epígrafe vem, ` +
      `tempestivamente, ${
        tipo === 'impugnacao'
          ? 'apresentar a presente manifestação quanto aos seguintes pontos'
          : 'solicitar os seguintes esclarecimentos'
      }:`,
    ``,
    corpo,
    ``,
    `Diante do exposto, requer-se a prestação dos esclarecimentos acima, ` +
      `se necessário com a republicação do edital e reabertura do prazo legal.`,
    ``,
    `Atenciosamente,`,
    `[Identificação do solicitante]`,
  ].join('\n');
}

export class GeminiDrafter implements DrafterPort {
  private readonly model: LanguageModel;

  /**
   * @param model LanguageModel injetável (testes passam um fake; produção
   * usa `google(config.EXTRACTOR_MODEL)`, resolvido preguiçosamente).
   */
  constructor(model?: LanguageModel) {
    this.model = model ?? google(getConfig().EXTRACTOR_MODEL);
  }

  async redigir(e: EditalExtraction): Promise<OficioGerado | null> {
    // Gate B canônico: nada a questionar → não há ofício (modelo nem é
    // chamado). O workflow (Phase 10) reaplica o gate B; aqui é defensivo.
    if (!temAlgoAQuestionar(e)) {
      return null;
    }

    const { object } = await generateObject({
      model: this.model,
      schema: OficioPropostoSchema,
      system: SYSTEM_PROMPT,
      prompt: montarPrompt(e),
    });

    // ---- LOOKUP ROBUSTO DE CONTENÇÃO (SPEC §5 #2, C2) ----
    // Só sobrevive a afirmação de revogação se o match em leisReferenciadas
    // for ÚNICO e statusVerificado='revogada'. O modelo NÃO escreve a frase;
    // ela é montada por `templateRevogada` abaixo.
    const leisCitadas: LeiNoOficio[] = [];
    // numero|ano → fonteVerificacao (para a frase-template de revogação).
    const fontePorLei = new Map<string, string | null>();

    for (const proposta of object.leisCitadas) {
      const lk = lookupLei(e, proposta.numero, proposta.ano);

      // Lei inventada → descartada (não inventa norma).
      if (lk.tipo === 'inventada') {
        continue;
      }

      // REGRA DURA: 'revogada' só sobrevive com match ÚNICO + verificado.
      // Não-identificável/ambígua (C2) → SEMPRE 'nenhuma'.
      const afirmacaoForcada: LeiNoOficio['afirmacaoVigencia'] =
        lk.tipo === 'unica' && lk.revogadaVerificada ? 'revogada' : 'nenhuma';

      leisCitadas.push({
        numero: proposta.numero,
        ano: proposta.ano,
        afirmacaoVigencia: afirmacaoForcada,
      });
      fontePorLei.set(
        `${proposta.numero}|${proposta.ano}`,
        lk.tipo === 'unica' ? lk.fonteVerificacao : null
      );
    }

    // ---- MONTAGEM 100% TEMPLATED DO CORPO ----
    // O modelo só forneceu SELEÇÕES (fonte+indice) de achados que já
    // existem na extração. Cada achado vira um ponto via TEMPLATE keyed
    // pelo TIPO ESTRUTURADO. NENHUM texto do modelo entra aqui — não há
    // campo de texto livre no schema. C1 (vazamento de prosa de revogação)
    // é estruturalmente impossível: não existe canal de prosa do modelo.
    const pontos: string[] = [];
    // De-dup: o modelo não pode duplicar o mesmo achado.
    const vistos = new Set<string>();

    for (const sel of object.selecoes) {
      const chave = `${sel.fonte}#${sel.indice}`;
      if (vistos.has(chave)) continue;

      if (sel.fonte === 'incoerencia') {
        const inc = e.incoerencias[sel.indice];
        if (!inc) continue; // índice inválido → ignora (sem crash, sem prosa).
        if (inc.severidade === 'baixa') continue; // gate B: baixa não entra.
        pontos.push(templateIncoerencia(inc.tipo));
        vistos.add(chave);
      } else if (sel.fonte === 'trechoAmbiguo') {
        const amb = e.trechosAmbiguos[sel.indice];
        if (!amb) continue;
        pontos.push(templateTrechoAmbiguo(amb.secaoOndeAparece));
        vistos.add(chave);
      } else {
        const p = e.pontosDeAtencao[sel.indice];
        if (!p) continue;
        if (!p.recomendaManifestacao) continue;
        pontos.push(templatePontoDeAtencao(p.categoria));
        vistos.add(chave);
      }
    }

    // Afirmações de (não)vigência: SEMPRE templates do adapter, keyed pelo
    // statusVerificado verificado. `templateRevogada` é o ÚNICO ponto que
    // introduz léxico de revogação, e só sob match ÚNICO + verificado.
    for (const l of leisCitadas) {
      if (l.afirmacaoVigencia === 'revogada') {
        const fonte = fontePorLei.get(`${l.numero}|${l.ano}`) ?? null;
        pontos.push(templateRevogada(l, fonte));
      } else {
        pontos.push(perguntaNeutraNorma(l));
      }
    }

    const markdown = montarMarkdown(e, object.tipo, pontos);

    // ---- TRIPWIRE DEFENSIVO (NÃO é a garantia) ----
    // O corpo é 100% templated; o ÚNICO léxico de vigência permitido vem de
    // `templateRevogada`, e só quando há lei revogada verificada. Se o
    // markdown casar o léxico SEM nenhuma lei revogada verificada, um
    // template introduziu prosa de status indevidamente → BUG ESTRUTURAL.
    const temRevogadaVerificada = leisCitadas.some(
      (l) => l.afirmacaoVigencia === 'revogada'
    );
    if (temLexicoVigencia(markdown) && !temRevogadaVerificada) {
      throw new Error(
        'TRIPWIRE Drafter: léxico de (não)vigência no markdown sem lei ' +
          'revogada verificada — bug estrutural (template introduziu prosa ' +
          'de status). A garantia é a ausência de prosa livre; este scan ' +
          'NUNCA deveria disparar (SPEC §5 #2).'
      );
    }

    return { tipo: object.tipo, markdown, leisCitadas };
  }
}
