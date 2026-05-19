import { describe, it, expect } from "vitest";
import { parseConfig } from "./config";

const minimalEnv = {
  GOOGLE_GENERATIVE_AI_API_KEY: "test-key",
  DATABASE_URL: "postgres://user:pass@host:5432/db?pgbouncer=true",
  DIRECT_URL: "postgres://user:pass@host:5432/db",
  APP_SECRET: "supersecret",
  WORKER_URL: "https://worker.example.com",
};

describe("parseConfig", () => {
  it("fails when GOOGLE_GENERATIVE_AI_API_KEY is absent", () => {
    const { GOOGLE_GENERATIVE_AI_API_KEY, ...withoutKey } = minimalEnv;
    expect(() => parseConfig(withoutKey)).toThrow();
  });

  it("fails when DATABASE_URL is absent", () => {
    const { DATABASE_URL, ...withoutDb } = minimalEnv;
    expect(() => parseConfig(withoutDb)).toThrow();
  });

  it("accepts minimal env and applies the EXTRACTOR_MODEL default", () => {
    const config = parseConfig(minimalEnv);
    expect(config.GOOGLE_GENERATIVE_AI_API_KEY).toBe("test-key");
    expect(config.DATABASE_URL).toBe(minimalEnv.DATABASE_URL);
    expect(config.DIRECT_URL).toBe(minimalEnv.DIRECT_URL);
    expect(config.APP_SECRET).toBe("supersecret");
    expect(config.WORKER_URL).toBe("https://worker.example.com");
    expect(config.EXTRACTOR_MODEL).toBe("gemini-2.5-flash");
  });

  it("respects an explicit EXTRACTOR_MODEL", () => {
    const config = parseConfig({
      ...minimalEnv,
      EXTRACTOR_MODEL: "gemini-2.5-pro",
    });
    expect(config.EXTRACTOR_MODEL).toBe("gemini-2.5-pro");
  });
});
