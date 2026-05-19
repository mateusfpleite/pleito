/**
 * Drafter adapter — Gemini Flash via Vercel AI SDK (`generateObject`).
 *
 * Pipeline step 7 (SPEC §4 / §5 #2). É a fase MAIS crítica de segurança do
 * produto: o ofício sai da Zelo para uma comissão de licitação externa. Se
 * uma afirmação de revogação NÃO verificada vazar, o dano à credibilidade é
 * irreversível (SPEC §5).
 *
 * CONTENÇÃO ESTRUTURAL REAL — princípio: ZERO string de texto livre de LLM
 * no ofício externo (SPEC §5 #2). "De LLM" = do modelo do Drafter OU de
 * qualquer campo `z.string()` livre produzido a montante pelo extractor /
 * pelo verifier (`fonteVerificacao` de grounding). O canal do MODELO já
 * estava fechado (schema strip); a 3ª review fechou os canais A MONTANTE
 * (`trechosAmbiguos[].secaoOndeAparece`, `fonteVerificacao` de grounding)
 * que vazavam verbatim, guardados só pelo tripwire léxico — que a SPEC
 * PROÍBE como garantia. A contenção é o INVARIANTE EXAUSTIVO do ponto 2,
 * não whack-a-mole de canal:
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
 *          referenciado por ÍNDICE não-LLM ("ponto nº N da análise") —
 *          `secaoOndeAparece` (z.string() LIVRE do extractor) NÃO é
 *          interpolado (C1 3ª: vazava verbatim);
 *        - pontoDeAtencao → template por `categoria` (enum).
 *      INVARIANTE EXAUSTIVO (não whack-a-mole de canal): todo caractere do
 *      `oficio.markdown` é (a) literal fixo de template, (b) valor de enum
 *      restrito (`incoerencia.tipo`, `pontoDeAtencao.categoria`, `tipo`),
 *      (c) escalar NÃO-LLM (índice/contagem/host curado de URL de baseline),
 *      ou (d) frase-template determinística de vigência. NENHUMA string de
 *      texto livre de LLM — do modelo do Drafter OU de QUALQUER campo
 *      `z.string()` livre da extração (extractor) ou do verifier
 *      (`fonteVerificacao` de grounding) — é interpolada, em lugar nenhum.
 *   3. Nenhuma string livre produzida por LLM (extractor, verifier OU
 *      drafter) chega ao documento. Todo caminho segue o estilo do "neutro
 *      determinístico" + as frases-template de revogação quando (e só
 *      quando) statusVerificado='revogada' e match único; a proveniência da
 *      revogação é frase FIXA — só cita a fonte (e só o HOST) quando a
 *      origem é comprovadamente a baseline curada (revogada-* de
 *      `data/norma-baseline.json`), nunca a string de grounding.
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
import { matchNorma } from '../../domain/norma-baseline.ts';
import { categoriaParaStatus } from '../../domain/categoria-status.ts';
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
 * Host curado de uma URL de baseline (classe (c): escalar não-LLM derivado
 * de dado curado, NÃO prosa). Só é chamada quando a origem é comprovadamente
 * a baseline curada (`fonteBaseline === true`). Renderiza APENAS o
 * domínio/host (ex.: `planalto.gov.br`), nunca texto arbitrário: mesmo a
 * fonte curada não é interpolada como prosa livre. `null` se não for uma URL
 * http(s) parseável ou se o host não casar a allowlist de domínios oficiais.
 */
const HOSTS_OFICIAIS =
  /(^|\.)(planalto\.gov\.br|gov\.br|in\.gov\.br|lexml\.gov\.br|senado\.leg\.br|camara\.leg\.br)$/i;

function hostCuradoSeguro(fonte: string | null): string | null {
  if (!fonte) return null;
  let host: string;
  try {
    const u = new URL(fonte.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    host = u.hostname.toLowerCase();
  } catch {
    return null;
  }
  return HOSTS_OFICIAIS.test(host) ? host : null;
}

/**
 * Frase-afirmação TEMPLATE de revogação — única forma de afirmar revogação
 * no ofício. Só é emitida quando o match foi ÚNICO e statusVerificado=
 * 'revogada'. É o ÚNICO ponto onde o léxico de vigência é introduzido, de
 * forma 100% controlada pelo adapter (não pelo modelo).
 *
 * INVARIANTE EXAUSTIVO (C1 3ª): `fonteVerificacao` é `z.string()` LIVRE no
 * caminho de grounding (VerdictSchema.fonte do verifier — string do LLM) e
 * NUNCA pode ser interpolada. A frase de proveniência é determinística e
 * FIXA ("conforme verificação de vigência registrada na análise"). Só quando
 * a origem é comprovadamente a BASELINE CURADA (`fonteBaseline === true`,
 * categoria revogada-* de `data/norma-baseline.json`) é admitida a citação
 * de fonte — e ainda assim renderizada de forma CONTROLADA: apenas o
 * domínio/host (classe (c), escalar não-LLM), nunca o texto arbitrário.
 */
function templateRevogada(
  l: LeiNoOficio,
  fonte: string | null,
  fonteBaseline: boolean
): string {
  // Frase de proveniência FIXA — nunca embute a string livre do verifier.
  let fonteRef = 'conforme verificação de vigência registrada na análise';
  if (fonteBaseline) {
    // Origem comprovadamente curada: pode citar a fonte, mas só o host
    // (escalar não-LLM derivado de dado curado), nunca texto arbitrário.
    const host = hostCuradoSeguro(fonte);
    if (host) {
      fonteRef =
        `conforme verificação de vigência registrada na análise ` +
        `(fonte oficial: ${host})`;
    }
  }
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
 * Template determinístico para trecho ambíguo. SEM slot dinâmico de prosa:
 * `secaoOndeAparece` é `z.string()` LIVRE do extractor (schema.ts) — prosa
 * de status poderia vazar por aí (C1 3ª: provado verbatim no markdown,
 * guardado só pelo tripwire léxico que a SPEC PROÍBE como garantia). A
 * localização útil ao leitor é dada por REFERÊNCIA POR ÍNDICE não-LLM
 * ("ponto nº N da análise") — número (classe (c)), nunca texto livre.
 *
 * @param indiceAnalise índice 0-based do ponto na ordem do ofício; o leitor
 * humano cruza com a análise estruturada (não-LLM).
 */
function templateTrechoAmbiguo(indiceAnalise: number): string {
  return (
    `**Ponto que demanda esclarecimento (ponto nº ${indiceAnalise + 1} da ` +
    `análise).** Identificou-se ambiguidade de redação no instrumento ` +
    `convocatório que dificulta a correta formulação das propostas. ` +
    `Solicita-se esclarecimento quanto à redação do referido ponto.`
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
      // `true` SÓ quando a lei casa a baseline CURADA (`matchNorma`) numa
      // categoria revogada-* (revogada-notoria/revogada-confirmada). Nesse
      // caso `fonteVerificacao` é dado curado de `data/norma-baseline.json`
      // — não a string livre de grounding do verifier. Distingue o canal
      // seguro (baseline) do canal de string livre (grounding).
      fonteBaseline: boolean;
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
  // Re-derivação determinística da PROVENIÊNCIA da fonte: a lei só conta
  // como "fonte baseline curada" se `matchNorma` (mesmo lookup curado do
  // Verifier/Tier 0) a resolve numa categoria revogada-* de
  // `data/norma-baseline.json`. Caso contrário (cauda → grounding), a
  // `fonteVerificacao` é string LIVRE do LLM verifier e NUNCA pode citar-se.
  const hit = matchNorma({
    numero: m.numero,
    ano: m.ano,
    escopo: m.escopo,
    tipoNorma: m.tipoNorma,
  });
  const fonteBaseline =
    hit !== null && categoriaParaStatus(hit.categoria) === 'revogada';
  return {
    tipo: 'unica',
    revogadaVerificada: m.statusVerificado === 'revogada',
    fonteVerificacao: m.fonteVerificacao,
    fonteBaseline,
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
    // numero|ano → proveniência da fonte (para a frase-template de
    // revogação). `fonteBaseline` distingue dado curado seguro (baseline)
    // da string LIVRE de grounding do verifier (NUNCA citável).
    const fontePorLei = new Map<
      string,
      { fonte: string | null; fonteBaseline: boolean }
    >();

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
        lk.tipo === 'unica'
          ? { fonte: lk.fonteVerificacao, fonteBaseline: lk.fonteBaseline }
          : { fonte: null, fonteBaseline: false }
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
        // Referência por ÍNDICE não-LLM: a posição que este ponto ocupará
        // no corpo (1-based via `montarMarkdown`). NÃO interpola
        // `amb.secaoOndeAparece` (z.string() livre do extractor — C1 3ª).
        pontos.push(templateTrechoAmbiguo(pontos.length));
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
        const prov = fontePorLei.get(`${l.numero}|${l.ano}`) ?? {
          fonte: null,
          fonteBaseline: false,
        };
        pontos.push(
          templateRevogada(l, prov.fonte, prov.fonteBaseline)
        );
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
