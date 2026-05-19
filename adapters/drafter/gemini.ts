/**
 * Drafter adapter — Gemini Flash via Vercel AI SDK (`generateObject`).
 *
 * Pipeline step 7 (SPEC §4 / §5 #2). É a fase MAIS crítica de segurança do
 * produto: o ofício sai da Zelo para uma comissão de licitação externa. Se
 * uma afirmação de revogação NÃO verificada vazar, o dano à credibilidade é
 * irreversível (SPEC §5).
 *
 * CONTENÇÃO ESTRUTURAL (não confiar em prosa livre do modelo) — SPEC §5 #2:
 *
 *   1. O modelo NÃO escreve o markdown. Ele produz, por ponto a questionar,
 *      apenas `{titulo, argumento}` (a divergência factual + o
 *      questionamento) e a lista `leisCitadas` com `afirmacaoVigencia`.
 *   2. O MARKDOWN final é montado DETERMINISTICAMENTE por este adapter.
 *      Afirmações de (não)vigência são SEMPRE frases-TEMPLATE keyed pelo
 *      `statusVerificado` verificado: só uma lei com match ÚNICO em
 *      `leisReferenciadas` e `statusVerificado==='revogada'` recebe a frase
 *      "a norma X encontra-se revogada, conforme [fonteVerificacao]".
 *      Qualquer outra lei → fraseado-pergunta neutro. O modelo NUNCA escreve
 *      frase de (não)vigência. Logo C1 (vazamento de revogação em prosa
 *      livre) é estruturalmente impossível — não há prosa livre.
 *   3. BACKSTOP LÉXICO (defense-in-depth, não delega ao Phase 9): após
 *      montar, cada SEGMENTO escrito pelo modelo (o `argumento` de cada
 *      ponto) passa por um scan léxico amplo de vigência. Se casar, o ponto
 *      é rebaixado para fraseado-pergunta puramente neutro (descarta o texto
 *      do modelo nesse ponto).
 *   4. LOOKUP ROBUSTO (C2): `numero===null`/`ano===null` nunca é match
 *      confiável; chave `numero|ano` não-única em `leisReferenciadas`
 *      também não → lei tratada como não-identificável (`nenhuma`/neutro).
 *      Asserção de revogação só com match ÚNICO + `statusVerificado` revogada.
 *
 * CONTRATO (`DrafterPort`):
 *   redigir(e: EditalExtraction): Promise<OficioGerado | null>
 *   - `null` quando o gate B canônico não dispara (sem incoerência de
 *     severidade≥média, sem trecho ambíguo, sem pontoDeAtencao com
 *     recomendaManifestacao). Nesse caso o modelo nem é chamado.
 *   - `OficioGerado = { tipo, markdown, leisCitadas: LeiNoOficio[] }`.
 *     `markdown` é SEMPRE montado por este adapter.
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
 * Schema do que o modelo propõe. NÃO inclui `markdown`: o modelo só produz
 * o ARGUMENTO de cada ponto (a divergência + questionamento) e a decisão
 * estruturada por lei. O markdown final é montado deterministicamente.
 */
const OficioPropostoSchema = z.object({
  tipo: z.enum(['esclarecimento', 'impugnacao']),
  pontos: z.array(
    z.object({
      titulo: z.string().min(1),
      argumento: z.string().min(1),
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
 * Léxico AMPLO de (não)vigência. Qualquer ocorrência num segmento escrito
 * pelo modelo (ou numa string de extração interpolada) é considerada
 * potencial vazamento e força fraseado neutro (backstop / scrub).
 */
const LEXICO_VIGENCIA =
  /revogad|perdeu vig[êe]ncia|n[ãa]o est[áa] mais em vigor|deixou de viger|sem vig[êe]ncia|caducou/i;

/** True se a string contém léxico de (não)vigência. */
function temLexicoVigencia(s: string): boolean {
  return LEXICO_VIGENCIA.test(s);
}

/**
 * Gate B canônico (SPEC §4 step 6 / Phase 10): só há ofício a redigir se a
 * extração traz:
 *   - incoerência com severidade ≥ média (alta OU media), OU
 *   - algum trecho ambíguo, OU
 *   - algum pontoDeAtencao com recomendaManifestacao.
 * Incoerência `severidade:'baixa'` SOZINHA NÃO dispara (I2).
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

/**
 * Frase-pergunta TEMPLATE neutra sobre uma norma — NUNCA afirma
 * (não)vigência; transforma em pergunta ao órgão.
 */
function perguntaNeutraNorma(l: LeiNoOficio): string {
  return (
    `**Norma aplicável.** Quanto à norma ${refLei(l.numero, l.ano)}, ` +
    `solicita-se confirmação sobre a norma efetivamente aplicável e o ` +
    `exato alcance das exigências dela decorrentes para fins deste certame.`
  );
}

/**
 * Frase-afirmação TEMPLATE de revogação — única forma de afirmar revogação
 * no ofício. Só é emitida pelo adapter quando o match em
 * `leisReferenciadas` foi ÚNICO e `statusVerificado==='revogada'`.
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

/**
 * Resultado do lookup robusto de uma lei proposta contra
 * `e.leisReferenciadas` (C2). `revogadaVerificada` só é `true` quando o
 * match é ÚNICO e `statusVerificado==='revogada'`.
 */
type Lookup =
  // numero/ano presentes mas SEM correspondência em leisReferenciadas →
  // lei inventada → DESCARTADA (não inventa norma).
  | { tipo: 'inventada' }
  // não-identificável (chave null) OU ambígua (chave não-única): a lei
  // existe conceitualmente mas NÃO dá pra atribuir status com segurança →
  // mantida no ofício porém SEMPRE `nenhuma`/fraseado neutro.
  | { tipo: 'naoIdentificavel' }
  // match ÚNICO: status verificado conhecido (única base para afirmar
  // revogação, e só se statusVerificado==='revogada').
  | {
      tipo: 'unica';
      revogadaVerificada: boolean;
      fonteVerificacao: string | null;
    };

/**
 * Lookup ROBUSTO (C2). Regras:
 *  - `numero===null` OU `ano===null` → não-identificável (nunca match
 *    confiável): mantida porém SEMPRE `nenhuma`/neutro;
 *  - chave `numero|ano` NÃO-única em leisReferenciadas → ambígua: idem
 *    (não dá pra atribuir status com segurança);
 *  - chave presente mas AUSENTE de leisReferenciadas → inventada → descarta;
 *  - só match ÚNICO + `statusVerificado==='revogada'` permite afirmar
 *    revogação (via template do adapter).
 */
function lookupLei(
  e: EditalExtraction,
  numero: string | null,
  ano: number | null
): Lookup {
  // numero/ano null nunca é match confiável — mas a lei não é "inventada":
  // o modelo a citou sem identificá-la → mantida com fraseado neutro.
  if (numero === null || ano === null) {
    return { tipo: 'naoIdentificavel' };
  }
  const matches = e.leisReferenciadas.filter(
    (r) => r.numero === numero && r.ano === ano
  );
  if (matches.length === 0) {
    return { tipo: 'inventada' };
  }
  // Chave não-única → não dá pra atribuir status com segurança (C2).
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

/**
 * Ofício neutro de questionamento, 100% determinístico (sem LLM, sem
 * NENHUMA afirmação de (não)vigência) — usado quando o lookup obrigou a
 * rebaixar alguma afirmação do modelo.
 *
 * I1 — LEXICON-SAFE POR CONSTRUÇÃO: NÃO interpola `descricao` /
 * `porQueAmbiguo` verbatim. Usa fraseado por CATEGORIA/tipo (template). Se,
 * por excesso de zelo, alguma string da extração fosse interpolada e ela
 * contiver léxico de vigência, é substituída por referência neutra.
 */
function oficioNeutroDeterministico(
  e: EditalExtraction,
  leisCitadas: LeiNoOficio[]
): OficioGerado {
  const NEUTRO =
    'ponto identificado na análise; solicita-se esclarecimento e, sendo o ' +
    'caso, a devida retificação do instrumento convocatório.';
  const pontos: string[] = [];

  for (const inc of e.incoerencias) {
    if (inc.severidade === 'baixa') continue;
    // Fraseado por TIPO (template) — nunca interpola inc.descricao verbatim.
    // O próprio rótulo do tipo (`lei-revogada`) contém léxico de vigência →
    // escrubado para referência neutra (lexicon-safe por construção).
    const tipoLabel = temLexicoVigencia(inc.tipo)
      ? 'identificada na análise'
      : `da categoria ${inc.tipo}`;
    pontos.push(
      `**Divergência identificada.** Constatou-se divergência ${tipoLabel} ` +
        `no instrumento convocatório. ${NEUTRO}`
    );
  }
  for (const amb of e.trechosAmbiguos) {
    // secaoOndeAparece é metadado curto; ainda assim escrubado por garantia.
    const secao = temLexicoVigencia(amb.secaoOndeAparece)
      ? 'seção indicada na análise'
      : amb.secaoOndeAparece;
    pontos.push(
      `**Trecho ambíguo (${secao}).** Identificou-se ambiguidade de ` +
        `redação no instrumento convocatório. Solicita-se esclarecimento ` +
        `quanto à redação para permitir a correta formulação das propostas.`
    );
  }
  for (const p of e.pontosDeAtencao.filter((x) => x.recomendaManifestacao)) {
    pontos.push(
      `**Ponto de atenção (${p.categoria}).** Identificou-se ponto ` +
        `relevante na exigência. Solicita-se esclarecimento sobre a ` +
        `exigência e sua fundamentação.`
    );
  }
  // Para cada lei citada, só PERGUNTA neutra (jamais afirmação de vigência).
  for (const l of leisCitadas) {
    pontos.push(perguntaNeutraNorma(l));
  }

  const markdown = montarMarkdown(e, 'esclarecimento', pontos);
  return { tipo: 'esclarecimento', markdown, leisCitadas };
}

export class GeminiDrafter implements DrafterPort {
  private readonly model: LanguageModel;

  /**
   * @param model LanguageModel injetável (testabilidade — testes passam um
   * fake; produção usa `google(config.EXTRACTOR_MODEL)`). Default resolvido
   * preguiçosamente para não exigir env/API key nos testes que injetam.
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
    // Para cada lei proposta: só sobrevive a afirmação de revogação se o
    // match em leisReferenciadas for ÚNICO e statusVerificado='revogada'.
    let modeloRebaixado = false;
    const leisCitadas: LeiNoOficio[] = [];
    // numero|ano → fonteVerificacao (para a frase-template de revogação).
    const fontePorLei = new Map<string, string | null>();

    for (const proposta of object.leisCitadas) {
      const lk = lookupLei(e, proposta.numero, proposta.ano);

      // Lei inventada (chave presente mas ausente de leisReferenciadas) →
      // descartada (não inventa norma).
      if (lk.tipo === 'inventada') {
        modeloRebaixado = true;
        continue;
      }

      // REGRA DURA: 'revogada' só sobrevive com match ÚNICO + verificado.
      // Não-identificável/ambígua (C2) → SEMPRE 'nenhuma'.
      const afirmacaoForcada: LeiNoOficio['afirmacaoVigencia'] =
        lk.tipo === 'unica' && lk.revogadaVerificada ? 'revogada' : 'nenhuma';

      if (afirmacaoForcada !== proposta.afirmacaoVigencia) {
        modeloRebaixado = true;
      }

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

    // Se o lookup obrigou a rebaixar/descartar algo, o conjunto de pontos do
    // modelo não é confiável → ofício neutro determinístico, lexicon-safe
    // por construção (campo estruturado E prosa coerentes).
    if (modeloRebaixado) {
      return oficioNeutroDeterministico(e, leisCitadas);
    }

    // ---- MONTAGEM DETERMINÍSTICA DO MARKDOWN (C1 estruturalmente
    // impossível: o modelo NUNCA escreveu prosa de (não)vigência) ----
    const pontos: string[] = [];

    // 1) Pontos a questionar: o modelo só forneceu titulo+argumento. O
    //    argumento passa pelo BACKSTOP LÉXICO: se contiver léxico de
    //    vigência, o ponto é rebaixado para fraseado-pergunta neutro
    //    (descarta o texto do modelo nesse ponto). Defense-in-depth: não
    //    delegamos isso só ao Phase 9.
    for (const p of object.pontos) {
      const tituloLimpo = temLexicoVigencia(p.titulo)
        ? 'Ponto identificado na análise'
        : p.titulo;
      if (temLexicoVigencia(p.argumento)) {
        pontos.push(
          `**${tituloLimpo}.** Identificou-se ponto relevante no ` +
            `instrumento convocatório. Solicita-se esclarecimento e, sendo ` +
            `o caso, a devida retificação do instrumento convocatório.`
        );
      } else {
        pontos.push(
          `**${tituloLimpo}.** ${p.argumento} Solicita-se esclarecimento ` +
            `sobre o ponto e, sendo o caso, a devida retificação do ` +
            `instrumento convocatório.`
        );
      }
    }

    // 2) Afirmações de (não)vigência: SEMPRE templates do adapter, keyed
    //    pelo statusVerificado verificado. O modelo nunca escreve isto.
    for (const l of leisCitadas) {
      if (l.afirmacaoVigencia === 'revogada') {
        const fonte = fontePorLei.get(`${l.numero}|${l.ano}`) ?? null;
        pontos.push(templateRevogada(l, fonte));
      } else {
        pontos.push(perguntaNeutraNorma(l));
      }
    }

    const markdown = montarMarkdown(e, object.tipo, pontos);
    return { tipo: object.tipo, markdown, leisCitadas };
  }
}
