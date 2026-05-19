/**
 * Ports do domínio (hexagonal). Type-only: zero dependência de runtime.
 * Adapters concretos (Gemini, Prisma, etc.) implementam estas interfaces;
 * o `application/` orquestra-os sem conhecer a tecnologia.
 *
 * Sequência do pipeline (SPEC §4):
 *   Preprocessor → Extractor → gate A → NormaVerifier? → RiskAnalyst
 *   → gate B → Drafter? → grava (AnalysisRepo) + Telemetria.
 */
import type { EditalExtraction, FonteMeta } from './schema.ts';

export type { FonteMeta };

/** Resultado do Preprocessor: texto plano + metadados observados da fonte. */
export type TextoExtraido = {
  texto: string;
  fonte: FonteMeta;
};

/** Entrada bruta do edital (arquivo recebido pelo upload). */
export type ArquivoEntrada = {
  nomeArquivo: string;
  bytes: Uint8Array;
  url: string | null;
};

/**
 * 1. Preprocessor — zip/gz/pdf → texto (pdftotext -layout no worker).
 * `fonte.ocr=true` quando o texto extraído vem vazio (sinaliza necessidade
 * de OCR a jusante).
 */
export interface PreprocessorPort {
  preprocessar(arquivo: ArquivoEntrada): Promise<TextoExtraido>;
}

/**
 * 2. Extractor — Gemini Flash, sem tool. Produz schema v3.
 * Flags `revogada` são PROVISÓRIAS (palpite); `statusVerificado` fica no
 * default `nao-verificado` até passar pelo NormaVerifier.
 */
export interface ExtractorPort {
  extrair(texto: string, fonte: FonteMeta): Promise<EditalExtraction>;
}

/**
 * 4. Norma Verifier (condicional, disparado pelo gate A) — baseline
 * (precedência, custo zero) → web grounding (cauda) → cache. Devolve a
 * extração com `leisReferenciadas[].statusVerificado` e `fonteVerificacao`
 * preenchidos.
 */
export interface NormaVerifierPort {
  verificar(e: EditalExtraction): Promise<EditalExtraction>;
}

/**
 * 5. Risk Analyst — preenche `pontosDeAtencao[]`, consumindo o status já
 * VERIFICADO das leis (nunca a flag crua do extractor).
 */
export interface RiskAnalystPort {
  analisar(e: EditalExtraction): Promise<EditalExtraction>;
}

/** Status de vigência afirmado pelo Drafter, por lei citada (SPEC §5 #2). */
export type AfirmacaoVigencia = 'nenhuma' | 'revogada' | 'vigente';

/** Decisão estruturada do Drafter por lei citada (contenção §5 #2). */
export type LeiNoOficio = {
  numero: string | null;
  ano: number | null;
  afirmacaoVigencia: AfirmacaoVigencia;
};

/** Ofício gerado pelo Drafter (condicional, disparado pelo gate B). */
export type OficioGerado = {
  tipo: 'esclarecimento' | 'impugnacao';
  markdown: string;
  leisCitadas: LeiNoOficio[];
};

/**
 * 7. Drafter (condicional) — decide `afirmacaoVigencia` por lei e gera a
 * prosa A PARTIR dessa decisão (ordem decide→escreve). Só afirma revogação
 * se `statusVerificado=revogada`; senão pergunta ao órgão.
 */
export interface DrafterPort {
  redigir(e: EditalExtraction): Promise<OficioGerado>;
}

/** Análise persistida (JSON da extração + ofício gerado/exportado). */
export type AnaliseRegistro = {
  id: string;
  jobId: string;
  municipio: string;
  uf: string;
  extracao: EditalExtraction;
  oficioGerado: OficioGerado | null;
  oficioExportado: string | null;
};

/** Repositório de análises (adapters/repo, único a tocar Prisma). */
export interface AnalysisRepo {
  salvar(
    registro: Omit<AnaliseRegistro, 'id'>
  ): Promise<AnaliseRegistro>;
  buscarPorId(id: string): Promise<AnaliseRegistro | null>;
}

export type JobStatus = 'pending' | 'running' | 'done' | 'erro';

export type Job = {
  id: string;
  status: JobStatus;
  erro: string | null;
  inputRef: string;
  createdAt: Date;
};

/**
 * Repositório de jobs. `claimNext` faz o claim atômico
 * (FOR UPDATE SKIP LOCKED) — dois workers nunca pegam o mesmo job.
 */
export interface JobRepo {
  criar(inputRef: string): Promise<Job>;
  claimNext(): Promise<Job | null>;
  marcarConcluido(id: string): Promise<void>;
  marcarErro(id: string, erro: string): Promise<void>;
  buscarPorId(id: string): Promise<Job | null>;
}

export type NormaStatus =
  | 'vigente'
  | 'revogada'
  | 'contestada'
  | 'inexistente'
  | 'nao-verificado';

export type NormaCacheEntry = {
  chave: string;
  status: NormaStatus;
  fonte: string;
  verificadoEm: Date;
};

/** Cache de status verificado de normas (reuso entre análises). */
export interface NormaCache {
  obter(chave: string): Promise<NormaCacheEntry | null>;
  gravar(
    entry: Omit<NormaCacheEntry, 'verificadoEm'>
  ): Promise<void>;
}

/**
 * Telemetria — eventos implícitos (export, re-upload, painéis, latência) e
 * o custo por chamada de grounding logado individualmente (SPEC §11b).
 */
export interface TelemetryPort {
  registrar(
    analysisId: string,
    evento: string,
    payload: Record<string, unknown>
  ): Promise<void>;
}
