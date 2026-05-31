import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    R2_BUCKET:
      process.env.NODE_ENV === "production"
        ? z.string().min(1)
        : z.string().min(1).optional(),
    R2_ACCOUNT_ID:
      process.env.NODE_ENV === "production"
        ? z.string().min(1)
        : z.string().min(1).optional(),
    R2_ACCESS_KEY_ID:
      process.env.NODE_ENV === "production"
        ? z.string().min(1)
        : z.string().min(1).optional(),
    R2_SECRET_ACCESS_KEY:
      process.env.NODE_ENV === "production"
        ? z.string().min(1)
        : z.string().min(1).optional(),
    R2_ENDPOINT:
      process.env.NODE_ENV === "production"
        ? z.string().url()
        : z.string().url().optional(),
  },
  clientPrefix: "",
  client: {},
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
  skipValidation:
    !!process.env.CI || process.env.npm_lifecycle_event === "lint",
});
