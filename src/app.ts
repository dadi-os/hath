import Fastify, { LogController, type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { Db, Sql } from "./db/client.js";
import type { ChaaviClient } from "./chaavi/client.js";
import type { DwarClient } from "./dwar/client.js";
import type { GharClient } from "./ghar/client.js";
import type { NasClient } from "./nas/client.js";
import type { YaadClient } from "./yaad/client.js";
import { HathError } from "./errors.js";
import { registerRequestLogging } from "./logging.js";
import { createRuntime, type Runtime } from "./runtime/engine.js";
import { hydrateTranscript } from "./db/messages.js";
import { recoverInterruptedWakes } from "./runtime/recovery.js";
import { registerV1 } from "./routers/index.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    db: Db;
    sql: Sql;
    dwar: DwarClient;
    yaad: YaadClient;
    ghar: GharClient;
    chaavi: ChaaviClient;
    nas: NasClient;
    runtime: Runtime;
  }
}

/** Build the Hath Fastify app with nas-aligned request logging. */
export async function buildApp(
  config: Config,
  deps: {
    db: Db;
    sql: Sql;
    dwar: DwarClient;
    yaad: YaadClient;
    ghar: GharClient;
    chaavi: ChaaviClient;
    nas: NasClient;
    runtime?: Runtime;
  },
): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: 16 * 1024 * 1024,
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      level: config.env.logLevel,
      base: { service: "hath" },
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      formatters: {
        level(label) {
          return { level: label };
        },
      },
    },
  });
  await registerRequestLogging(app);
  const runtime =
    deps.runtime ??
    createRuntime({
      db: deps.db,
      dwar: deps.dwar,
      yaad: deps.yaad,
      ghar: deps.ghar,
      chaavi: deps.chaavi,
      nas: deps.nas,
      config,
      log: app.log,
    });
  if (!deps.runtime) {
    await hydrateTranscript(deps.db, runtime.transcript);
    await recoverInterruptedWakes({
      db: deps.db,
      transcript: runtime.transcript,
      events: runtime.events,
      enqueueConversation: runtime.enqueueConversation,
      log: app.log,
    });
  }
  app.decorate("config", config);
  app.decorate("db", deps.db);
  app.decorate("sql", deps.sql);
  app.decorate("dwar", deps.dwar);
  app.decorate("yaad", deps.yaad);
  app.decorate("ghar", deps.ghar);
  app.decorate("chaavi", deps.chaavi);
  app.decorate("nas", deps.nas);
  app.decorate("runtime", runtime);
  runtime.scheduler.start();
  app.addHook("onClose", async () => {
    runtime.scheduler.stop();
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof HathError) {
      request.log.warn(
        { code: err.type, request_id: request.requestId, status: err.statusCode },
        err.message,
      );
      return reply.status(err.statusCode).send({
        error: { type: err.type, message: err.message },
      });
    }
    const statusCode =
      typeof err === "object" &&
      err !== null &&
      "statusCode" in err &&
      typeof err.statusCode === "number"
        ? err.statusCode
        : 500;
    const message = err instanceof Error ? err.message : "internal error";
    if (statusCode >= 400 && statusCode < 500) {
      request.log.warn(
        { code: "invalid_request", request_id: request.requestId, status: statusCode },
        message,
      );
      return reply.status(statusCode).send({
        error: { type: "invalid_request", message },
      });
    }
    request.log.error(
      { code: "internal_error", request_id: request.requestId, status: 500, err },
      "internal error",
    );
    return reply.status(500).send({
      error: { type: "internal_error", message: "internal error" },
    });
  });

  /** Process start ISO — process identity only; not a chat epoch. */
  const startedAt = new Date().toISOString();
  app.get("/health", async () => ({ status: "ok", started_at: startedAt }));
  await app.register(registerV1);
  return app;
}
