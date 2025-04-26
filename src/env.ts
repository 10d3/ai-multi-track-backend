import { createEnv } from "@t3-oss/env-core";
import z from "zod";

export const env = createEnv({
  //   clientPrefix: "PUBLIC_",
  server: {
    DATABASE_URL: z.string().url(),
    // OPEN_AI_API_KEY: z.string().min(1),
    JSWT_SECRET: z.string().min(1),
    WORKER_URL: z.string().min(1),
    WORKER_PORT: z.number().min(1),
    REDIS_HOST: z.string().min(1),
    REDIS_PORT: z.number().min(1),
    REDIS_PASSWORD: z.string().min(1),
    REDIS_USERNAME: z.string().min(1),
    SERVER_PORT: z.string().min(1),
    BUCKET_NAME: z.string().min(1),
    ZYPHRA_API_KEY: z.string().min(1),
  },
  //   client: {
  //     PUBLIC_PUBLISHABLE_KEY: z.string().min(1),
  //   },
  /**
   * Makes sure you explicitly access **all** environment variables
   * from `server` and `client` in your `runtimeEnv`.
   */
  runtimeEnvStrict: {
    DATABASE_URL: process.env.DATABASE_URL,
    // OPEN_AI_API_KEY: process.env.OPEN_AI_API_KEY,
    JSWT_SECRET: process.env.JSWT_SECRET,
    WORKER_URL: process.env.WORKER_URL,
    WORKER_PORT: process.env.WORKER_PORT,
    REDIS_HOST: process.env.REDIS_HOST,
    REDIS_PORT: process.env.REDIS_PORT,
    REDIS_PASSWORD: process.env.REDIS_PASSWORD,
    REDIS_USERNAME: process.env.REDIS_USERNAME,
    SERVER_PORT: process.env.SERVER_PORT,
    BUCKET_NAME: process.env.BUCKET_NAME,
    ZYPHRA_API_KEY: process.env.ZYPHRA_API_KEY,
    // PUBLIC_PUBLISHABLE_KEY: process.env.PUBLIC_PUBLISHABLE_KEY,
  },
});
