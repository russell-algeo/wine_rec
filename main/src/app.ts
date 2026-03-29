import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { z } from "zod";

import {
  createAnalysisResponseSchema,
} from "@wine-rec/contracts";

import { appConfig } from "./config.js";
import {
  RequestError,
  cancelAnalysis,
  createUploadAnalysis,
  createUrlAnalysis,
  getAnalysisRun,
  getPreview,
  getProviderHealth,
} from "./api-handlers.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
  });

  await app.register(cors, {
    methods: ["GET", "POST", "PUT", "OPTIONS"],
    origin: (origin, callback) => {
      if (!origin || appConfig.webOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} is not allowed`), false);
    },
  });
  await app.register(multipart);
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Wine Rec API",
        version: "0.1.0",
      },
    },
  });
  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  app.get("/", async () => {
    return {
      name: "Wine Rec API",
      status: "ok",
      docsUrl: "/docs",
      healthUrl: "/api/health/providers",
    };
  });

  app.get("/favicon.ico", async (_, reply) => {
    return reply.status(204).send();
  });

  app.get("/api/preview", async (request, reply) => {
    const { url } = request.query as { url?: string };
    if (!url) {
      return reply.status(400).send({ error: "url query parameter is required" });
    }

    try {
      return reply.send(await getPreview(url));
    } catch (error) {
      if (error instanceof RequestError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get("/api/health/providers", async () => {
    return getProviderHealth();
  });

  app.post("/api/uploads", async (request, reply) => {
    const file = await request.file();
    if (!file) {
      return reply.status(400).send({ message: "Missing file field" });
    }

    try {
      return createAnalysisResponseSchema.parse(
        await createUploadAnalysis({
          buffer: await file.toBuffer(),
          filename: file.filename,
          mimeType: file.mimetype,
        }),
      );
    } catch (error) {
      if (error instanceof RequestError) {
        return reply.status(error.statusCode).send({ message: error.message });
      }
      throw error;
    }
  });

  app.post("/api/urls", async (request, reply) => {
    const parsed = z.object({ url: z.string() }).parse(request.body);

    try {
      return createAnalysisResponseSchema.parse(await createUrlAnalysis(parsed));
    } catch (error) {
      if (error instanceof RequestError) {
        return reply.status(error.statusCode).send({ message: error.message });
      }
      throw error;
    }
  });

  app.get("/api/analyses/:id", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const analysis = await getAnalysisRun(params.id);
    if (!analysis) {
      return reply.status(404).send({ message: "Analysis not found" });
    }
    return analysis;
  });

  app.post("/api/analyses/:id/cancel", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const analysis = await cancelAnalysis(params.id);
    if (!analysis) {
      return reply.status(404).send({ message: "Analysis not found" });
    }
    return analysis;
  });

  return app;
}
