import "./util/loadEnv.js";
import path from "node:path";
import fs from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { config, validateConfig } from "./config.js";
import { initDb, purgeExpiredLogs } from "./db/index.js";
import { authPlugin, registerAuthRoutes } from "./auth/index.js";
import { registerApi } from "./routes/api.js";
import { startSmtp } from "./smtp/server.js";
import { syncDirectory } from "./directory/sync.js";
import { uploadHeaders } from "./util/uploads.js";

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
  const app = Fastify({ logger: true, trustProxy: config.trustProxy });
  app.addHook("onRequest", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
  });
  await app.register(cookie);
  await app.register(cors, {
    origin: [config.publicUrl, ...config.corsOrigins],
    credentials: true
  });
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024 } });
  // Opt-in: only the routes that ask for it are limited, so the portal's own
  // polling of /api/auth/me and /api/bootstrap is unaffected.
  await app.register(rateLimit, { global: false });
  await app.register(authPlugin);
  registerAuthRoutes(app);
  registerApi(app);

  const uploadsDir = path.join(config.dataDir, "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });
  await app.register(fastifyStatic, {
    root: uploadsDir,
    prefix: "/uploads/",
    decorateReply: false,
    // Uploads share an origin with the portal, so they are served with headers
    // that stop a file being treated as a document. Files stored before upload
    // validation existed are covered too: anything not a known raster image is
    // sent as a download rather than rendered.
    setHeaders: (reply, filePath) => {
      for (const [header, value] of Object.entries(uploadHeaders(filePath))) {
        reply.header(header, value);
      }
    }
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

  await app.listen({ port: config.httpPort, host: config.httpHost });
  await startSmtp();

  const purge = () => {
    try {
      const removed = purgeExpiredLogs();
      if (removed.mailLog || removed.auditLog) {
        console.log(`[signer] Retention: removed ${removed.mailLog} activity and ${removed.auditLog} audit entries`);
      }
    } catch (err) {
      console.error("[signer] Retention purge failed", err);
    }
  };
  purge();
  setInterval(purge, 60 * 60 * 1000).unref();

  if (config.directorySyncMinutes > 0) {
    const sync = () => {
      void syncDirectory()
        .then((results) => {
          for (const r of results) {
            if (r.error) console.error(`[signer] Directory sync (${r.source}) failed: ${r.error}`);
            else console.log(`[signer] Directory sync (${r.source}): ${r.users} people, ${r.groups} groups`);
          }
        })
        .catch((err) => console.error("[signer] Directory sync failed", err));
    };
    // Once shortly after start, so a restart never leaves the cache a full interval behind.
    setTimeout(sync, 60 * 1000).unref();
    setInterval(sync, config.directorySyncMinutes * 60 * 1000).unref();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
