import "./util/loadEnv.js";
import path from "node:path";
import fs from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { config, validateConfig } from "./config.js";
import { initDb } from "./db/index.js";
import { authPlugin, registerAuthRoutes } from "./auth/index.js";
import { registerApi } from "./routes/api.js";
import { startSmtp } from "./smtp/server.js";
import { syncDirectory } from "./directory/sync.js";

function reportConfig(): void {
  const { fatal, warnings } = validateConfig();
  for (const warning of warnings) console.warn(`[signer] WARNING: ${warning}`);
  if (fatal.length) {
    for (const problem of fatal) console.error(`[signer] FATAL: ${problem}`);
    console.error("[signer] Refusing to start with an unsafe configuration. Set DEMO_MODE=true for a lab instance.");
    process.exit(1);
  }
}

async function main(): Promise<void> {
  reportConfig();
  initDb();
  const app = Fastify({ logger: true, trustProxy: true });
  await app.register(cookie);
  await app.register(cors, {
    origin: [config.publicUrl, ...config.corsOrigins],
    credentials: true
  });
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024 } });
  await app.register(authPlugin);
  registerAuthRoutes(app);
  registerApi(app);

  const uploadsDir = path.join(config.dataDir, "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });
  await app.register(fastifyStatic, {
    root: uploadsDir,
    prefix: "/uploads/",
    decorateReply: false
  });

  const webDist = path.resolve("web/dist");
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/"
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/uploads/")) {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html", webDist);
    });
  }

  await app.listen({ port: config.httpPort, host: "0.0.0.0" });
  startSmtp();

  if (config.directorySyncMinutes > 0) {
    const ms = config.directorySyncMinutes * 60 * 1000;
    setInterval(() => {
      void syncDirectory().catch((err) => console.error("Directory sync failed", err));
    }, ms);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
