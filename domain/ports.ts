/**
 * Ports do domínio (hexagonal). Type-only: zero dependência de runtime.
 * Adapters concretos (Gemini, Prisma, etc.) implementam estas interfaces;
 * o `application/` orquestra-os sem conhecer a tecnologia.
 *
 * Sequência do pipeline (SPEC §4):
 *   Preprocessor → Extractor → gate A → NormaVerifier? → RiskAnalyst
 *   → gate B → Drafter? → grava (AnalysisRepo) + Telemetria.
 */
import type {
  EditalExtraction,
  ExtractorOutput,
  FonteMeta,
} from './schema.ts';

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
 * 2. Extractor — Gemini Flash, sem tool. Produz `ExtractorOutput`
 * (schema v3 SEM `pontosDeAtencao`). Esse campo é do Risk Analyst (step 5,
 * SPEC §4) — o Extractor NÃO o produz; o `application/` recompõe o
 * `EditalExtraction` completo com `pontosDeAtencao: []` antes do Risk
 * Analyst preenchê-lo. Flags `revogada` são PROVISÓRIAS (palpite);
 * `statusVerificado` fica no default `nao-verificado` até o NormaVerifier.
 */
export interface ExtractorPort {
  extrair(texto: string, fonte: FonteMeta): Promise<ExtractorOutput>;
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
 *
 * Retorna `null` quando NADA justifica manifestação (sem incoerências,
 * trechos ambíguos ou pontos de atenção que recomendem manifestação). O
 * workflow (Phase 10) também aplica o gate B; o Drafter, por sua vez, é
 * defensivo e devolve `null` se a extração não traz nada a questionar.
 */
export interface DrafterPort {
  redigir(e: EditalExtraction): Promise<OficioGerado | null>;
}

/** Análise persistida (JSON da extração + ofício gerado/exportado). */
export type AnaliseRegistro = {
  id: string;
  jobId: string;
  municipio: string;
  uf: string;
  extracao: EditalExtraction;
  oficioGerado: OficioGerado | null;
  /**
   * Texto do ofício EXACTAMENTE como exportado pela Stefany (a textarea
   * editável da Phase 13). Persistido no ATO do export (Phase 14) — o
   * diff `oficioGerado` × `oficioExportado` é sinal-ouro de eval (§11b).
   * O PDF do ofício é renderizado a partir DESTE texto, nunca regenerado
   * do JSON/markdown original (SPEC §9 — persistir conteúdo, nunca o PDF).
   */
  oficioExportado: string | null;
  /** Carimbo de tempo do export do ofício (null até o 1º export). */
  oficioExportadoEm: Date | null;
};

/** Repositório de análises (adapters/repo, único a tocar Prisma). */
export interface AnalysisRepo {
  salvar(
    registro: Omit<AnaliseRegistro, 'id'>
  ): Promise<AnaliseRegistro>;
  buscarPorId(id: string): Promise<AnaliseRegistro | null>;
  /**
   * Busca a análise de um Job (1:1 no V0). `/api/status/:id` recebe o
   * jobId; a UI nunca conhece o id da Analysis — só o do Job.
   */
  buscarPorJobId(jobId: string): Promise<AnaliseRegistro | null>;
  /**
   * Persiste o texto editado do ofício no ATO do export (Phase 14, §9):
   * grava `oficioExportado` + `oficioExportadoEm`. O PDF é então
   * renderizado a partir do texto AGORA persistido — nunca regenerado do
   * JSON. Devolve o registro atualizado.
   */
  registrarOficioExportado(
    id: string,
    texto: string
  ): Promise<AnaliseRegistro>;
  /**
   * Lista as análises mais recentes (desc por `createdAt`) — superfície
   * de revisão interna (`/admin`, SPEC §11b: "sem isso o loop não
   * fecha"). `limite` default razoável; read-only.
   */
  listarRecentes(limite?: number): Promise<AnaliseRegistro[]>;
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

/** Um evento de telemetria materializado (leitura — superfície /admin). */
export type EventoTelemetria = {
  analysisId: string;
  evento: string;
  payload: Record<string, unknown>;
  createdAt: Date;
};

/**
 * Telemetria — eventos implícitos (export, re-upload, painéis, latência) e
 * o custo por chamada de grounding logado individualmente (SPEC §11b).
 * Escrita NÃO-bloqueante (via `application/telemetria.registrarSeguro`); a
 * leitura (`listarPorAnalises`) só alimenta a superfície de revisão
 * interna (`/admin`) — read-only, fora do caminho do pipeline.
 */
export interface TelemetryPort {
  registrar(
    analysisId: string,
    evento: string,
    payload: Record<string, unknown>
  ): Promise<void>;
  /**
   * Eventos das análises dadas (p/ `/admin`: feedback + diffs por
   * análise). Devolve só os eventos cujos `analysisId` ∈ `ids`.
   */
  listarPorAnalises(ids: string[]): Promise<EventoTelemetria[]>;
}
