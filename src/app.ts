import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { Static, Type } from "@sinclair/typebox";
import { HttpError } from "./errors.js";
import { createSigningSecret, hashPassword, validateWebhookUrl, verifyPassword } from "./security.js";
import type { Repository } from "./types.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; email: string };
    user: { sub: string; email: string };
  }
}

const credentialsSchema = Type.Object({
  email: Type.String({ minLength: 5, maxLength: 254, format: "email" }),
  password: Type.String({ minLength: 12, maxLength: 256 })
}, { additionalProperties: false });

const endpointInputSchema = Type.Object({
  url: Type.String({ minLength: 12, maxLength: 2048 }),
  eventTypes: Type.Array(Type.String({ minLength: 3, maxLength: 100, pattern: "^[a-z][a-z0-9_.-]*$" }),
    { minItems: 1, maxItems: 20, uniqueItems: true })
}, { additionalProperties: false });

const eventInputSchema = Type.Object({
  type: Type.String({ minLength: 3, maxLength: 100, pattern: "^[a-z][a-z0-9_.-]*$" }),
  idempotencyKey: Type.String({ minLength: 8, maxLength: 128 }),
  payload: Type.Record(Type.String(), Type.Any())
}, { additionalProperties: false });

const authResponseSchema = Type.Object({ token: Type.String(), tokenType: Type.Literal("Bearer") });
const endpointSchema = Type.Object({
  id: Type.String(), userId: Type.String(), url: Type.String(),
  eventTypes: Type.Array(Type.String()), enabled: Type.Boolean(), createdAt: Type.String()
});

interface AppOptions {
  repository: Repository;
  jwtSecret: string;
  logger?: boolean;
}

export async function createApp({ repository, jwtSecret, logger = false }: AppOptions): Promise<FastifyInstance> {
  if (jwtSecret.length < 32) throw new Error("JWT secret must be at least 32 characters");
  const app = Fastify({ logger, bodyLimit: 64 * 1024 });

  await app.register(swagger, {
    openapi: {
      info: { title: "RelayForge API", version: "1.0.0", description: "Reliable webhook deliveries with idempotency and bounded retries." },
      components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } }
    }
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  await app.register(jwt, { secret: jwtSecret, sign: { expiresIn: "2h" } });
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation) {
      void reply.code(400).send({ error: "Validation failed", details: error.message });
      return;
    }
    if (error instanceof HttpError) {
      void reply.code(error.statusCode).send({ error: error.message });
      return;
    }
    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
    if (statusCode >= 500) request.log.error(error);
    void reply.code(statusCode).send({ error: statusCode >= 500 ? "Internal server error" : error.message });
  });

  app.get("/health", { schema: { tags: ["System"], summary: "Liveness check" } },
    async () => ({ status: "ok" }));

  app.get("/ready", { schema: { tags: ["System"], summary: "Database readiness check" } }, async (_request, reply) => {
    try {
      await repository.ping();
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ error: "Database unavailable" });
    }
  });

  app.post<{ Body: Static<typeof credentialsSchema> }>("/auth/register", {
    schema: { tags: ["Authentication"], summary: "Create an account", body: credentialsSchema,
      response: { 201: authResponseSchema } },
    config: { rateLimit: { max: 8, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const email = request.body.email.trim().toLowerCase();
    if (await repository.findUserByEmail(email)) throw new HttpError(409, "Email is already registered");
    const user = await repository.createUser(email, await hashPassword(request.body.password));
    const token = app.jwt.sign({ sub: user.id, email: user.email });
    return reply.code(201).send({ token, tokenType: "Bearer" });
  });

  app.post<{ Body: Static<typeof credentialsSchema> }>("/auth/login", {
    schema: { tags: ["Authentication"], summary: "Sign in", body: credentialsSchema,
      response: { 200: authResponseSchema } },
    config: { rateLimit: { max: 8, timeWindow: "1 minute" } }
  }, async request => {
    const email = request.body.email.trim().toLowerCase();
    const user = await repository.findUserByEmail(email);
    if (!user || !(await verifyPassword(request.body.password, user.passwordHash))) {
      throw new HttpError(401, "Invalid credentials");
    }
    return { token: app.jwt.sign({ sub: user.id, email: user.email }), tokenType: "Bearer" as const };
  });

  const authenticate = async (request: FastifyRequest): Promise<void> => {
    await request.jwtVerify();
  };

  app.post<{ Body: Static<typeof endpointInputSchema> }>("/v1/endpoints", {
    onRequest: authenticate,
    schema: { tags: ["Endpoints"], summary: "Register an HTTPS webhook destination", security: [{ bearerAuth: [] }],
      body: endpointInputSchema,
      response: { 201: Type.Intersect([endpointSchema, Type.Object({ signingSecret: Type.String() })]) } }
  }, async (request, reply) => {
    let url: string;
    try {
      url = validateWebhookUrl(request.body.url);
    } catch (error: unknown) {
      throw new HttpError(400, error instanceof Error ? error.message : "Invalid endpoint URL");
    }
    const secret = createSigningSecret();
    const endpoint = await repository.createEndpoint(request.user.sub,
      { url, eventTypes: request.body.eventTypes }, secret);
    return reply.code(201).send({ ...endpoint, signingSecret: secret });
  });

  app.get("/v1/endpoints", {
    onRequest: authenticate,
    schema: { tags: ["Endpoints"], summary: "List my destinations (secrets omitted)",
      security: [{ bearerAuth: [] }], response: { 200: Type.Array(endpointSchema) } }
  }, async request => repository.listEndpoints(request.user.sub));

  app.post<{ Body: Static<typeof eventInputSchema> }>("/v1/events", {
    onRequest: authenticate,
    schema: { tags: ["Events"], summary: "Queue an event with an idempotency key",
      security: [{ bearerAuth: [] }], body: eventInputSchema,
      response: { 202: Type.Object({ eventId: Type.String(), deliveriesQueued: Type.Integer(), duplicate: Type.Boolean() }) } }
  }, async (request, reply) => {
    const result = await repository.enqueueEvent(request.user.sub, request.body);
    return reply.code(202).send(result);
  });

  app.get("/v1/deliveries", {
    onRequest: authenticate,
    schema: { tags: ["Deliveries"], summary: "View my latest 100 webhook deliveries", security: [{ bearerAuth: [] }],
      response: { 200: Type.Array(Type.Object({
        id: Type.String(), eventId: Type.String(), eventType: Type.String(), endpointUrl: Type.String(),
        status: Type.String(), attempts: Type.Integer(), responseCode: Type.Union([Type.Integer(), Type.Null()]),
        lastError: Type.Union([Type.String(), Type.Null()]), updatedAt: Type.String()
      })) } }
  }, async request => repository.listDeliveries(request.user.sub));

  await app.ready();
  return app;
}
