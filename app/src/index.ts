// Cloudflare Workers エントリポイント

import { buildApp } from "./app.ts";
import { D1Db } from "./db/db.ts";

type WorkerEnv = Env & { BOOTSTRAP_PASSWORD?: string };

let cachedApp: ReturnType<typeof buildApp> | null = null;

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
    if (!cachedApp) {
      cachedApp = buildApp({
        db: new D1Db(env.DB),
        environment: env.ENVIRONMENT ?? "preview",
        bootstrapPassword: env.BOOTSTRAP_PASSWORD,
        getClientIp: (req) => req.headers.get("cf-connecting-ip") ?? "",
      });
    }
    return cachedApp.fetch(request, env, ctx);
  },
};
