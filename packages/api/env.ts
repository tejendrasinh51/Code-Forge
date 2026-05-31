import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    JUDGE_API_URL: z
      .string()
      .url()
      .default("https://judge.codeforge.xyz/api/v1"),
    JUDGE_API_TOKEN:
      process.env.NODE_ENV === "production"
        ? z.string().min(1)
        : z.string().min(1).optional(),
  },

  runtimeEnv: process.env,

  emptyStringAsUndefined: true,
  skipValidation:
    !!process.env.CI || process.env.npm_lifecycle_event === "lint",
});
