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
 * Parses and validates the configuration from an injected env object.
 * Fails early (throws) if a required variable is missing.
 */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return result.data;
}

let cachedConfig: Config | undefined;

/**
 * Returns the validated process configuration (process.env), cached.
 * Fails early on the first call if a required variable is missing.
 */
export function getConfig(): Config {
  if (!cachedConfig) {
    cachedConfig = parseConfig(process.env);
  }
  return cachedConfig;
}
