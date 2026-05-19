import { z } from 'zod';

export const EditalExtractionSchema = z.object({
  // Identificação
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

  // Regime jurídico (top-level)
  regimeJuridico: z.enum([
    'lei-14133',
    'lei-13303',
    'lei-8666',
    'lei-10520',
    'rdc',
    'misto',
    'outro',
  ]),

  // Objeto (com captura de divergência capa vs corpo)
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

  // Valor & julgamento
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

  // Habilitação estruturada
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

  // Exigências regulatórias setoriais
  exigenciasRegulatorias: z.object({
    licencaSanitaria: z.boolean(),
    alvaraFuncionamento: z.boolean(),
    vistoria: z.boolean(),
    amostra: z.boolean(),
    outros: z.array(z.string()),
  }),

  // Itens funerários
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

  // Leis referenciadas
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
      // v3: status pós-verificação (Norma Verifier). Default = não-verificado;
      // o extractor não preenche — só a flag `revogada` (palpite provisório).
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

  // Anexos
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

  // Achados para revisão humana
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

  // --- Campos v3 (SPEC §6) ---
  plataforma: z.string().nullable(),
  subcontratacaoPermitida: z.boolean().nullable(),
  intervaloMinimoLances: z.number().nullable(),
  prazoRecursosDiasUteis: z.number().nullable(),
  informacoesViabilidade: z.string().nullable(),

  // Pontos de atenção (Risk Analyst) — severidade dirige UI/Gate B
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

  // Metadata da fonte
  fonte: z.object({
    pdfNativo: z.boolean(),
    ocr: z.boolean(),
    paginas: z.number(),
    url: z.string().nullable(),
  }),
});

export type EditalExtraction = z.infer<typeof EditalExtractionSchema>;

/**
 * Metadados da fonte do edital, propagados pelo Preprocessor para o Extractor
 * (origem do arquivo, OCR aplicado, paginação). Distinto do `fonte` do schema,
 * que é o que o LLM declara — `FonteMeta` é o que o pipeline observa.
 */
export type FonteMeta = {
  nomeArquivo: string;
  pdfNativo: boolean;
  ocr: boolean;
  paginas: number;
  url: string | null;
};
