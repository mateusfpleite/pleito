/**
 * Telemetria de aplicação (SPEC §11b) — eventos IMPLÍCITOS de fricção zero
 * + o sinal-ouro (diff ofício) + custo de grounding POR chamada.
 *
 * INVARIANTE CRÍTICA: telemetria NUNCA derruba o pipeline. `registrarSeguro`
 * embrulha todo `TelemetryPort.registrar` em try/catch — falha de
 * telemetria SÓ loga (console.error) e segue. Nenhum caller deve chamar
 * `telemetry.registrar` direto no caminho de produção; sempre via
 * `registrarSeguro` (defesa em profundidade contra um adapter de
 * persistência indisponível tomar o job inteiro).
 *
 * Os builders abaixo são puros (sem I/O) — o payload de cada evento é
 * testável isoladamente; o `registrarSeguro` é testado contra um
 * `TelemetryPort` fake que LANÇA (prova a não-propagação).
 */
import type { TelemetryPort } from '../domain/ports.ts';
import { calcularDiffOficio, type OficioDiff } from '../domain/oficio-diff.ts';

/** Nomes canônicos dos eventos (1 lugar — evita string mágica divergível). */
export const EVENTO = {
  /** Pipeline terminou OK — latência total + custo agregado. */
  analiseConcluida: 'analise_concluida',
  /** Edital submetido — `inputHash` p/ detectar re-upload a jusante. */
  submissao: 'submissao',
  /** Mesmo edital re-submetido (hash repetido) — sinal de iteração dela. */
  reupload: 'reupload',
  /** Export disparado (tipo relatorio|oficio). */
  export: 'export',
  /** SINAL-OURO: diff ofício gerado×exportado (métrica do delta). */
  oficioDiff: 'oficio_diff',
  /** Ofício exportado difere do gerado (atalho booleano do sinal-ouro). */
  oficioEditado: 'oficio_editado',
  /** Custo/uso de UMA chamada de web grounding (não agregado — §11b). */
  groundingCusto: 'grounding_custo',
  /** Feedback explícito mínimo (👍/👎 + texto). */
  feedback: 'feedback',
} as const;

/**
 * Registra um evento de telemetria de forma NÃO-BLOQUEANTE: qualquer
 * exceção do adapter é capturada e só logada. Devolve `true` se gravou,
 * `false` se a telemetria falhou (o caller IGNORA o retorno no caminho
 * feliz — existe só p/ teste e logs).
 */
export async function registrarSeguro(
  telemetry: TelemetryPort,
  analysisId: string,
  evento: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  try {
    await telemetry.registrar(analysisId, evento, payload);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[telemetria] evento '${evento}' falhou (não-bloqueante, ` +
        `pipeline segue): ${msg}`
    );
    return false;
  }
}

/** Hash estável e curto do input do edital (p/ detectar re-upload). */
export function hashInput(bytes: Uint8Array): string {
  // FNV-1a 32-bit — determinístico, sem dependência, suficiente p/
  // agrupar re-submissões do MESMO edital (não é hash criptográfico).
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Payload de `analise_concluida` (latência + custo agregado). */
export function payloadAnaliseConcluida(args: {
  latenciaMs: number;
  groundingChamadas: number;
  groundingTokensTotais: number;
  oficioGerado: boolean;
}): Record<string, unknown> {
  return {
    latenciaMs: args.latenciaMs,
    groundingChamadas: args.groundingChamadas,
    groundingTokensTotais: args.groundingTokensTotais,
    oficioGerado: args.oficioGerado,
  };
}

/**
 * Payload do SINAL-OURO + decisão de fallback. Quando o diff é vazio
 * (`foiEditado=false`: aceitou sem editar OU não exportou), `sinalOuro`
 * é `false` e o caller usa o RESERVA (export-sim/não + 👍/👎) — este
 * payload já carrega `exportou` p/ o reserva ser auto-suficiente.
 */
export function payloadOficioDiff(
  diff: OficioDiff,
  exportou: boolean
): Record<string, unknown> {
  return {
    sinalOuro: diff.foiEditado,
    foiEditado: diff.foiEditado,
    linhasAdicionadas: diff.linhasAdicionadas,
    linhasRemovidas: diff.linhasRemovidas,
    distanciaCaracteres: diff.distanciaCaracteres,
    tamanhoGerado: diff.tamanhoGerado,
    tamanhoExportado: diff.tamanhoExportado,
    // RESERVA: se sinalOuro=false, este é o sinal disponível (§11b).
    exportou,
  };
}

/** Re-exporta o cálculo do diff (1 import só p/ os callers). */
export { calcularDiffOficio };
export type { OficioDiff };

/**
 * Payload do custo de UMA chamada de grounding (SPEC §11b — não só
 * agregado: bomba de custo silenciosa se só agregado). `usdEstimado` é
 * marcado como estimativa quando o SDK não devolve custo exato (só uso).
 */
export function payloadGroundingCusto(args: {
  lei: string;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
}): Record<string, unknown> {
  const total =
    args.totalTokens ??
    (args.inputTokens ?? 0) + (args.outputTokens ?? 0);
  return {
    lei: args.lei,
    inputTokens: args.inputTokens ?? null,
    outputTokens: args.outputTokens ?? null,
    totalTokens: total,
    // Sem tabela de preço por modelo no V0: registramos o USO e marcamos
    // como estimativa (§11b — o que importa é ser POR chamada, visível).
    estimativa: true,
  };
}
