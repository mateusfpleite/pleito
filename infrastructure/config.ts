import { z } from "zod";

const configSchema = z.object({
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1),
  APP_SECRET: z.string().min(1),
  WORKER_URL: z.string().min(1),
  EXTRACTOR_MODEL: z.string().min(1).default("gemini-2.5-flash"),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Parseia e valida a configuração a partir de um objeto de env injetado.
 * Falha cedo (throw) se uma variável obrigatória estiver ausente.
 */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Configuração de ambiente inválida: ${issues}`);
  }
  return result.data;
}

let cachedConfig: Config | undefined;

/**
 * Retorna a configuração validada do processo (process.env), cacheada.
 * Falha cedo na primeira chamada se faltar variável obrigatória.
 */
export function getConfig(): Config {
  if (!cachedConfig) {
    cachedConfig = parseConfig(process.env);
  }
  return cachedConfig;
}
