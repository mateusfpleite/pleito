import { z } from 'zod';

export const EditalExtractionSchema = z.object({
  // Identification
  municipio: z.string(),
  uf: z.string().length(2),
  ente: z.object({
    tipo: z.enum([
      'prefeitura',
      'camara',
      'autarquia',
      'empresa-publica',
      'sociedade-economia-mista',
      'consorcio',
      'fundacao',
      'outro',
    ]),
    razaoSocial: z.string(),
    cnpj: z.string().nullable(),
  }),
  modalidade: z.enum([
    'pregao-eletronico',
    'pregao-presencial',
    'concorrencia',
    'dispensa',
    'rdc',
    'dialogo-competitivo',
    'leilao',
    'credenciamento',
    'chamamento-publico',
    'outro',
  ]),
  numero: z.string(),
  processoAdministrativo: z.string().nullable(),
  dataPublicacao: z.string().nullable(),
  dataSessao: z.string().nullable(),
  uasg: z.string().nullable(),

  // Legal regime (top-level)
  regimeJuridico: z.enum([
    'lei-14133',
    'lei-13303',
    'lei-8666',
    'lei-10520',
    'rdc',
    'misto',
    'outro',
  ]),

  // Object (with capture of cover vs body divergence)
  objetoCorpo: z.string(),
  objetoCapa: z.string().nullable(),
  objetoSummary: z.string(),
  tipoObjeto: z.array(
    z.enum([
      'auxilio-funeral-loas',
      'concessao-cemiterio',
      'concessao-crematorio',
      'fornecimento-urnas',
      'transporte-funerario',
      'servicos-funerarios-completos',
      'tanatopraxia',
      'coroa-flores',
      'manutencao-cemiterio',
      'construcao-jazigos',
      'cremacao-fornecida',
      'gestao-administrativa-cemiterio',
      'outro',
    ])
  ),
  secretariaDemandante: z.string().nullable(),

  // Value & judgment
  valor: z.object({
    estimado: z.number().nullable(),
    sigiloso: z.boolean(),
    procedencia: z.enum(['capa', 'termo-referencia', 'preambulo', 'sigiloso']),
  }),
  moeda: z.literal('BRL'),
  criterioJulgamento: z.enum([
    'menor-preco',
    'maior-desconto',
    'maior-outorga',
    'tecnica-preco',
    'maior-retorno',
    'outro',
  ]),
  agrupamento: z.enum(['item', 'lote', 'grupo', 'global']),
  modoDisputa: z.enum(['aberto', 'fechado', 'aberto-fechado']).nullable(),
  regimeExecucao: z
    .enum([
      'preco-unitario',
      'preco-global',
      'empreitada',
      'empreitada-integral',
      'contratacao-integrada',
      'contratacao-semi-integrada',
      'tarefa',
    ])
    .nullable(),

  // Prazos
  vigenciaContrato: z.object({
    meses: z.number().nullable(),
    prorrogavelAteMeses: z.number().nullable(),
  }),
  vigenciaAtaRP: z
    .object({
      meses: z.number().nullable(),
      prorrogavelAteMeses: z.number().nullable(),
    })
    .nullable(),
  validadeProposta: z
    .object({
      dias: z.number(),
    })
    .nullable(),

  // Structured qualification
  habilitacao: z.object({
    juridica: z.array(
      z.object({
        exigencia: z.string(),
        baseLegal: z.string().nullable(),
        observacao: z.string().nullable(),
      })
    ),
    fiscalTrabalhista: z.array(
      z.object({
        exigencia: z.string(),
        baseLegal: z.string().nullable(),
        observacao: z.string().nullable(),
      })
    ),
    economicoFinanceira: z.array(
      z.object({
        exigencia: z.string(),
        baseLegal: z.string().nullable(),
        observacao: z.string().nullable(),
      })
    ),
    tecnica: z.array(
      z.object({
        exigencia: z.string(),
        baseLegal: z.string().nullable(),
        observacao: z.string().nullable(),
      })
    ),
  }),

  // Sector-specific regulatory requirements
  exigenciasRegulatorias: z.object({
    licencaSanitaria: z.boolean(),
    alvaraFuncionamento: z.boolean(),
    vistoria: z.boolean(),
    amostra: z.boolean(),
    outros: z.array(z.string()),
  }),

  // Funeral items
  itensLicitados: z.array(
    z.object({
      numero: z.string(),
      descricao: z.string(),
      tipo: z.enum([
        'urna',
        'vestimento',
        'coroa',
        'translado',
        'preparo-corpo',
        'tanatopraxia',
        'ornamentacao',
        'sepultamento',
        'velorio',
        'cremacao',
        'outro',
      ]),
      publicoAlvo: z
        .enum([
          'adulto',
          'adulto-obeso',
          'juvenil',
          'infantil',
          'recem-nascido',
          'qualquer',
        ])
        .nullable(),
      unidade: z.string(),
      quantidade: z.number(),
      valorUnitarioReferencial: z.number().nullable(),
    })
  ),

  // Referenced laws
  leisReferenciadas: z.array(
    z.object({
      descricao: z.string(),
      escopo: z.enum([
        'federal',
        'estadual',
        'municipal',
        'distrital',
        'constitucional',
        'infralegal',
      ]),
      tipoNorma: z.enum([
        'lei',
        'decreto',
        'portaria',
        'regulamento-interno',
        'deliberacao',
        'constituicao',
        'resolucao',
        'instrucao-normativa',
        'outro',
      ]),
      numero: z.string().nullable(),
      ano: z.number().nullable(),
      contextoNoEdital: z.string(),
      revogada: z.boolean(),
      // v3: post-verification status (Norma Verifier). Default = nao-verificado;
      // the extractor does not fill it — only the `revogada` flag (provisional guess).
      statusVerificado: z
        .enum([
          'vigente',
          'revogada',
          'contestada',
          'inexistente',
          'nao-verificado',
        ])
        .default('nao-verificado'),
      fonteVerificacao: z.string().nullable(),
    })
  ),

  // Annexes
  anexos: z.array(
    z.object({
      numero: z.string(),
      titulo: z.string(),
      tipo: z.enum([
        'termo-referencia',
        'minuta-contrato',
        'minuta-ata',
        'modelo-proposta',
        'modelo-declaracao',
        'estudo-tecnico-preliminar',
        'cadastro-reserva',
        'outro',
      ]),
      descricaoBreve: z.string(),
      presenteNoArquivo: z.boolean(),
      fonteSeparada: z.string().nullable(),
    })
  ),

  // Findings for human review
  incoerencias: z.array(
    z.object({
      tipo: z.enum([
        'valor-divergente',
        'objeto-divergente',
        'lei-revogada',
        'numeracao-quebrada',
        'outro',
      ]),
      descricao: z.string(),
      severidade: z.enum(['alta', 'media', 'baixa']),
    })
  ),
  trechosAmbiguos: z.array(
    z.object({
      trechoLiteral: z.string(),
      porQueAmbiguo: z.string(),
      secaoOndeAparece: z.string(),
    })
  ),

  // --- v3 fields (SPEC §6) ---
  plataforma: z.string().nullable(),
  subcontratacaoPermitida: z.boolean().nullable(),
  intervaloMinimoLances: z.number().nullable(),
  prazoRecursosDiasUteis: z.number().nullable(),
  informacoesViabilidade: z.string().nullable(),

  // Points of attention (Risk Analyst) — severity drives UI/Gate B
  pontosDeAtencao: z.array(
    z.object({
      descricao: z.string(),
      categoria: z.enum([
        'financeiro',
        'operacional',
        'juridico',
        'competitivo',
      ]),
      severidade: z.enum(['alta', 'media', 'baixa']),
      recomendaManifestacao: z.boolean(),
    })
  ),

  // Source metadata
  fonte: z.object({
    pdfNativo: z.boolean(),
    ocr: z.boolean(),
    paginas: z.number(),
    url: z.string().nullable(),
  }),
});

export type EditalExtraction = z.infer<typeof EditalExtractionSchema>;

/**
 * Schema of the **Extractor output** (pipeline step 2). Omits
 * `pontosDeAtencao`: that field is the **Risk Analyst**'s responsibility
 * (step 5 — SPEC §4), not the Extractor's. Forcing Gemini to fill it in
 * the extraction's `generateObject` would make the model fabricate points
 * of attention (data invented in the middle of the pipeline). The
 * `application/` reassembles the full `EditalExtraction` by adding
 * `pontosDeAtencao: []` (explicit placeholder), which the Risk Analyst
 * fills downstream.
 *
 * `leisReferenciadas[].statusVerificado` has `.default('nao-verificado')`,
 * so Zod fills it at parse time even though the extractor does not emit it
 * (the Norma Verifier's responsibility, step 4).
 */
export const ExtractorOutputSchema = EditalExtractionSchema.omit({
  pontosDeAtencao: true,
});

export type ExtractorOutput = z.infer<typeof ExtractorOutputSchema>;

/**
 * Edital source metadata, propagated by the Preprocessor to the Extractor
 * (file origin, OCR applied, pagination). Distinct from the schema's
 * `fonte`, which is what the LLM declares — `FonteMeta` is what the
 * pipeline observes.
 */
export type FonteMeta = {
  nomeArquivo: string;
  pdfNativo: boolean;
  ocr: boolean;
  paginas: number;
  url: string | null;
};
