import { createHash, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import * as client from "openid-client";
import { config, entraConfigured, googleLoginConfigured } from "../config.js";
import { resolveRole, type SessionUser } from "../db/index.js";

const cookieName = "signer_session";
const secret = new Uint8Array(createHash("sha256").update(config.sessionSecret).digest());

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

async function signSession(user: SessionUser): Promise<string> {
  return new SignJWT(user as unknown as Record<string, string>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(secret);
}

async function readSession(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret);
    return {
      email: String(payload.email || "").toLowerCase(),
      name: String(payload.name || ""),
      picture: payload.picture ? String(payload.picture) : undefined,
      provider: payload.provider as SessionUser["provider"],
      role: payload.role as SessionUser["role"]
    };
  } catch {
    return null;
  }
}

export async function setSession(reply: FastifyReply, user: SessionUser): Promise<void> {
  const token = await signSession({ ...user, role: resolveRole(user.email) });
  reply.setCookie(cookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: config.publicUrl.startsWith("https"),
    maxAge: 60 * 60 * 12
  });
}

export const authPlugin = fp(async function authPlugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest("user", null);
  app.addHook("preHandler", async (req) => {
    req.user = await readSession(req.cookies[cookieName]);
    if (req.user) req.user.role = resolveRole(req.user.email);
  });
});

export function requireUser(req: FastifyRequest, reply: FastifyReply): SessionUser | null {
  if (!req.user) {
    reply.code(401).send({ error: "Authentication required" });
    return null;
  }
  return req.user;
}

export function requireRole(roles: SessionUser["role"][], req: FastifyRequest, reply: FastifyReply): SessionUser | null {
  const user = requireUser(req, reply);
  if (!user) return null;
  if (user.role === "super_admin" || user.role === "owner") return user;
  if (!roles.includes(user.role)) {
    reply.code(403).send({ error: "Insufficient permissions" });
    return null;
  }
  return user;
}

const pkceCookie = "signer_pkce";

async function entraConfig(): Promise<client.Configuration> {
  return client.discovery(
    new URL(`https://login.microsoftonline.com/${config.entra.tenantId}/v2.0`),
    config.entra.clientId,
    config.entra.clientSecret
  );
}

async function googleConfig(): Promise<client.Configuration> {
  return client.discovery(new URL("https://accounts.google.com"), config.google.clientId, config.google.clientSecret);
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.get("/api/auth/providers", async () => ({
    entra: entraConfigured(),
    google: googleLoginConfigured(),
    dev: config.allowDevLogin && config.demoMode,
    superAdminConfigured: Boolean(config.superAdminEmail)
  }));

  app.get("/api/auth/me", async (req) => ({ user: req.user }));

  app.post("/api/auth/dev-login", async (req, reply) => {
    if (!(config.allowDevLogin && config.demoMode)) {
      return reply.code(403).send({ error: "Dev login is disabled" });
    }
    if (!config.superAdminEmail) {
      return reply.code(400).send({ error: "SUPER_ADMIN_EMAIL is not set" });
    }
    await setSession(reply, {
      email: config.superAdminEmail,
      name: "Super Admin",
      provider: "dev",
      role: "super_admin"
    });
    return { ok: true };
  });

  app.post("/api/auth/logout", async (_req, reply) => {
    reply.clearCookie(cookieName, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/entra/start", async (_req, reply) => {
    if (!entraConfigured()) return reply.code(400).send({ error: "Entra is not configured" });
    const oidc = await entraConfig();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = randomBytes(16).toString("hex");
    const url = client.buildAuthorizationUrl(oidc, {
      redirect_uri: `${config.publicUrl}/api/auth/entra/callback`,
      scope: "openid profile email",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state
    });
    reply.setCookie(pkceCookie, JSON.stringify({ codeVerifier, state, provider: "entra" }), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 600
    });
    return reply.redirect(url.href);
  });

  app.get("/api/auth/entra/callback", async (req, reply) => {
    const oidc = await entraConfig();
    const stored = JSON.parse(req.cookies[pkceCookie] || "{}") as { codeVerifier?: string; state?: string };
    const current = new URL(req.url, config.publicUrl);
    const tokens = await client.authorizationCodeGrant(oidc, current, {
      pkceCodeVerifier: stored.codeVerifier,
      expectedState: stored.state
    });
    const claims = tokens.claims();
    const email = String(claims?.email || claims?.preferred_username || "").toLowerCase();
    if (!email) return reply.code(400).send({ error: "Entra login did not return an email" });
    await setSession(reply, {
      email,
      name: String(claims?.name || email),
      picture: claims?.picture ? String(claims.picture) : undefined,
      provider: "entra",
      role: resolveRole(email)
    });
    reply.clearCookie(pkceCookie, { path: "/" });
    return reply.redirect("/");
  });

  app.get("/api/auth/google/start", async (_req, reply) => {
    if (!googleLoginConfigured()) return reply.code(400).send({ error: "Google is not configured" });
    const oidc = await googleConfig();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = randomBytes(16).toString("hex");
    const url = client.buildAuthorizationUrl(oidc, {
      redirect_uri: `${config.publicUrl}/api/auth/google/callback`,
      scope: "openid profile email",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state
    });
    reply.setCookie(pkceCookie, JSON.stringify({ codeVerifier, state, provider: "google" }), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 600
    });
    return reply.redirect(url.href);
  });

  app.get("/api/auth/google/callback", async (req, reply) => {
    const oidc = await googleConfig();
    const stored = JSON.parse(req.cookies[pkceCookie] || "{}") as { codeVerifier?: string; state?: string };
    const current = new URL(req.url, config.publicUrl);
    const tokens = await client.authorizationCodeGrant(oidc, current, {
      pkceCodeVerifier: stored.codeVerifier,
      expectedState: stored.state
    });
    const claims = tokens.claims();
    const email = String(claims?.email || "").toLowerCase();
    if (!email) return reply.code(400).send({ error: "Google login did not return an email" });
    await setSession(reply, {
      email,
      name: String(claims?.name || email),
      picture: claims?.picture ? String(claims.picture) : undefined,
      provider: "google",
      role: resolveRole(email)
    });
    reply.clearCookie(pkceCookie, { path: "/" });
    return reply.redirect("/");
  });
}
