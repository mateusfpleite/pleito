/**
 * Drafter adapter — Gemini Flash via Vercel AI SDK (`generateObject`).
 *
 * Pipeline step 7 (SPEC §4 / §5 #2). É a fase MAIS crítica de segurança do
 * produto: o ofício sai da Zelo para uma comissão de licitação externa. Se
 * uma afirmação de revogação NÃO verificada vazar, o dano à credibilidade é
 * irreversível (SPEC §5). Por isso a contenção NÃO é confiada ao modelo —
 * ela é um GUARD DETERMINÍSTICO neste adapter (defense in depth).
 *
 * CONTRATO (`DrafterPort`):
 *   redigir(e: EditalExtraction): Promise<OficioGerado | null>
 *   - `null` quando NADA justifica manifestação (gate B "interno": sem
 *     incoerências, sem trechosAmbiguos, sem pontoDeAtencao com
 *     recomendaManifestacao=true). Nesse caso o modelo nem é chamado.
 *   - `OficioGerado = { tipo, markdown, leisCitadas: LeiNoOficio[] }`.
 *
 * ORDEM decide→escreve (SPEC §5 #2): o prompt+few-shot guiam o modelo a
 * decidir `afirmacaoVigencia` por lei ANTES de escrever a prosa. O modelo
 * propõe; o adapter então aplica o GUARD:
 *
 *   REGRA DURA (forçada deterministicamente, sem confiar no modelo):
 *   para cada lei proposta em `leisCitadas`, o adapter procura a lei
 *   correspondente em `e.leisReferenciadas` (match numero+ano). Então:
 *     • lei não encontrada em leisReferenciadas → DESCARTADA (não inventa lei);
 *     • statusVerificado === 'revogada' → afirmacaoVigencia mantida 'revogada'
 *       (única forma de afirmar revogação no ofício);
 *     • QUALQUER outro status (contestada/inexistente/nao-verificado/vigente)
 *       → afirmacaoVigencia FORÇADA para 'nenhuma'. Mesmo 'vigente' não vira
 *       afirmação proativa.
 *
 *   Se o guard precisou rebaixar alguma afirmação (modelo tentou 'revogada'
 *   ou 'vigente' onde não pode), o markdown do modelo é considerado NÃO
 *   confiável (pode conter a afirmação proibida em prosa) e é SUBSTITUÍDO por
 *   um ofício neutro de QUESTIONAMENTO, gerado deterministicamente a partir
 *   das incoerências/ambíguos/pontos da extração, sem nenhuma afirmação de
 *   (não)vigência. Assim o campo estruturado E a prosa ficam coerentes (o
 *   gate Tier 0 da Phase 9 confronta justamente os dois).
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
 * Schema do que o modelo propõe (contrato `OficioGerado`). `generateObject`
 * valida — `tipo` fora do enum / faltando campo → throw. O guard pós-geração
 * é aplicado DEPOIS deste parse.
 */
const OficioPropostoSchema = z.object({
  tipo: z.enum(['esclarecimento', 'impugnacao']),
  markdown: z.string().min(1),
  leisCitadas: z.array(
    z.object({
      numero: z.string().nullable(),
      ano: z.number().nullable(),
      afirmacaoVigencia: z.enum(['nenhuma', 'revogada', 'vigente']),
    })
  ),
});

/**
 * Gate B "interno" do Drafter: só há ofício a redigir se a extração traz
 * algo a questionar. Espelha o gate B do workflow (SPEC §4 step 6 / Phase
 * 10) para tornar o adapter defensivo por si só.
 */
function temAlgoAQuestionar(e: EditalExtraction): boolean {
  return (
    e.incoerencias.length > 0 ||
    e.trechosAmbiguos.length > 0 ||
    e.pontosDeAtencao.some((p) => p.recomendaManifestacao)
  );
}

/** Ofício neutro de questionamento, 100% determinístico (sem LLM, sem
 * nenhuma afirmação de (não)vigência) — usado quando o guard não confia no
 * markdown do modelo. Formato fiel ao ofício de Pariconha. */
function oficioNeutroDeterministico(
  e: EditalExtraction,
  leisCitadas: LeiNoOficio[]
): OficioGerado {
  const pontos: string[] = [];

  for (const inc of e.incoerencias) {
    pontos.push(
      `**${inc.tipo}.** ${inc.descricao} Solicita-se esclarecimento sobre ` +
        `o ponto e, sendo o caso, a devida retificação do instrumento ` +
        `convocatório.`
    );
  }
  for (const amb of e.trechosAmbiguos) {
    pontos.push(
      `**Trecho ambíguo (${amb.secaoOndeAparece}).** ${amb.porQueAmbiguo} ` +
        `Solicita-se esclarecimento quanto à redação para permitir a ` +
        `correta formulação das propostas.`
    );
  }
  for (const p of e.pontosDeAtencao.filter((x) => x.recomendaManifestacao)) {
    pontos.push(
      `**${p.categoria}.** ${p.descricao} Solicita-se esclarecimento sobre ` +
        `a exigência e sua fundamentação.`
    );
  }
  // Para cada lei citada (status != revogada) acrescenta-se PERGUNTA neutra.
  for (const l of leisCitadas) {
    const ref = [l.numero ? `nº ${l.numero}` : null, l.ano ? `/${l.ano}` : null]
      .filter(Boolean)
      .join('');
    pontos.push(
      `**Norma aplicável.** Quanto à norma ${ref || 'invocada no edital'}, ` +
        `solicita-se confirmação sobre a norma efetivamente aplicável e o ` +
        `exato alcance das exigências dela decorrentes para fins deste ` +
        `certame.`
    );
  }
  if (pontos.length === 0) {
    pontos.push(
      'Solicita-se esclarecimento sobre os pontos identificados no edital.'
    );
  }

  const corpo = pontos
    .map((p, i) => `${i + 1}. ${p}`)
    .join('\n\n');

  const markdown = [
    `À Comissão de Licitação / Sr. Pregoeiro`,
    `${e.ente.razaoSocial} — ${e.municipio}/${e.uf}`,
    ``,
    `**Assunto:** Pedido de esclarecimento — ${e.modalidade} nº ${e.numero}.`,
    ``,
    `Prezados Senhores,`,
    ``,
    `A empresa interessada em participar do certame em epígrafe vem, ` +
      `tempestivamente, solicitar os seguintes esclarecimentos:`,
    ``,
    corpo,
    ``,
    `Diante do exposto, requer-se a prestação dos esclarecimentos acima, ` +
      `se necessário com a republicação do edital e reabertura do prazo legal.`,
    ``,
    `Atenciosamente,`,
    `[Identificação do solicitante]`,
  ].join('\n');

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
    // Gate B interno: sem nada a questionar → não há ofício (modelo nem é
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

    // ---- GUARD DETERMINÍSTICO DE CONTENÇÃO (SPEC §5 #2) ----
    // Não confiar no modelo: confrontar cada lei proposta com o
    // statusVerificado da lei correspondente em leisReferenciadas.
    let modeloRebaixado = false;
    const leisCitadas: LeiNoOficio[] = [];

    for (const proposta of object.leisCitadas) {
      const refLei = e.leisReferenciadas.find(
        (r) => r.numero === proposta.numero && r.ano === proposta.ano
      );
      // Lei inventada (não está em leisReferenciadas) → descartada.
      if (!refLei) {
        modeloRebaixado = true;
        continue;
      }

      // REGRA DURA: 'revogada' só sobrevive se statusVerificado==='revogada'.
      // Qualquer outro status → forçado a 'nenhuma' (inclui 'vigente').
      const afirmacaoForcada: LeiNoOficio['afirmacaoVigencia'] =
        refLei.statusVerificado === 'revogada' ? 'revogada' : 'nenhuma';

      if (afirmacaoForcada !== proposta.afirmacaoVigencia) {
        modeloRebaixado = true;
      }

      leisCitadas.push({
        numero: proposta.numero,
        ano: proposta.ano,
        afirmacaoVigencia: afirmacaoForcada,
      });
    }

    // Se o guard precisou rebaixar/descartar algo, o markdown do modelo é
    // suspeito (pode afirmar (não)vigência em prosa onde não pode). Substitui
    // por ofício neutro de QUESTIONAMENTO determinístico — campo estruturado
    // E prosa ficam coerentes (o gate Tier 0 confronta os dois).
    if (modeloRebaixado) {
      return oficioNeutroDeterministico(e, leisCitadas);
    }

    return {
      tipo: object.tipo,
      markdown: object.markdown,
      leisCitadas,
    };
  }
}
