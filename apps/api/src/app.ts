import { createReadStream } from "node:fs";

import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { z } from "zod";

import {
  analysisRunSchema,
  createAnalysisFromUrlRequestSchema,
  createAnalysisResponseSchema,
  preferencesResponseSchema,
  providerHealthSchema,
  sourceTypeSchema,
  userTastePreferenceSchema,
} from "@wine-rec/contracts";

import { appConfig } from "./config.js";
import { bootstrapDatabase } from "./db/bootstrap.js";
import { createOcrProvider } from "./providers/ocr.js";
import { createWineProfileProviders } from "./providers/wine-profiles.js";
import {
  createAnalysis,
  getAnalysisById,
  getPreferences,
  putPreferences,
  queueAnalysis,
  requestAnalysisCancellation,
  updateAnalysisStoragePath,
} from "./services/repository.js";
import {
  readAnalysisMetadata,
  saveUpload,
  saveUrlSource,
  writeAnalysisMetadata,
} from "./services/storage.js";

const uploadSourceSchema = z.object({
  sourceType: sourceTypeSchema,
});

function inferSourceType(mimeType: string | undefined): "upload-image" | "upload-pdf" {
  return mimeType === "application/pdf" ? "upload-pdf" : "upload-image";
}

function inferMimeType(filename: string, mimeType: string | undefined): string {
  if (mimeType) return mimeType;
  if (filename.toLowerCase().endsWith(".pdf")) return "application/pdf";
  return "image/jpeg";
}

function inferUrlSourceType(input: string): "url-html" | "url-pdf" {
  const url = new URL(input);
  return url.pathname.toLowerCase().endsWith(".pdf") ? "url-pdf" : "url-html";
}

function assertHttpUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported");
  }
  return url;
}

export async function buildApp(): Promise<FastifyInstance> {
  bootstrapDatabase();

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

  app.get("/api/health/providers", async () => {
    const ocrProvider = createOcrProvider();
    const providers = [
      {
        name: ocrProvider.name,
        availability: ocrProvider.isEnabled ? "enabled" : "disabled",
        enabled: ocrProvider.isEnabled,
        detail: ocrProvider.detail,
      },
      ...createWineProfileProviders().map((provider) => ({
        name: provider.name,
        availability: provider.isEnabled ? "enabled" : "disabled",
        enabled: provider.isEnabled,
        detail: provider.detail,
      })),
    ];

    return z.array(providerHealthSchema).parse(providers);
  });

  app.get("/api/preferences", async () => {
    return preferencesResponseSchema.parse({
      preferences: await getPreferences(),
    });
  });

  app.put("/api/preferences", async (request) => {
    const parsed = userTastePreferenceSchema.parse(request.body);
    const preferences = await putPreferences(parsed);
    return preferencesResponseSchema.parse({ preferences });
  });

  app.post("/api/uploads", async (request, reply) => {
    const file = await request.file();
    if (!file) {
      return reply.status(400).send({ message: "Missing file field" });
    }

    const buffer = await file.toBuffer();
    const sourceType = uploadSourceSchema.parse({
      sourceType: inferSourceType(file.mimetype),
    }).sourceType;
    const mimeType = inferMimeType(file.filename, file.mimetype);
    const analysis = await createAnalysis({
      sourceType,
      sourceFilename: file.filename,
      storagePath: "",
    });

    const storagePath = await saveUpload(analysis.id, file.filename, buffer);
    const hydrated = await getAnalysisById(analysis.id);
    if (!hydrated) {
      throw new Error("Newly created analysis could not be loaded");
    }

    await writeAnalysisMetadata(analysis.id, storagePath, { mimeType });
    await updateAnalysisStoragePath(analysis.id, storagePath);

    return createAnalysisResponseSchema.parse({
      analysisId: hydrated.id,
      status: hydrated.status,
    });
  });

  app.post("/api/urls", async (request, reply) => {
    const parsed = createAnalysisFromUrlRequestSchema.parse(request.body);
    let url: URL;

    try {
      url = assertHttpUrl(parsed.url);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid URL";
      return reply.status(400).send({ message });
    }

    const analysis = await createAnalysis({
      sourceType: inferUrlSourceType(url.toString()),
      sourceFilename: url.toString(),
      storagePath: "",
    });

    const storagePath = await saveUrlSource(analysis.id, url.toString());
    await writeAnalysisMetadata(analysis.id, storagePath, {
      sourceUrl: url.toString(),
      mimeType: "text/uri-list",
    });
    await updateAnalysisStoragePath(analysis.id, storagePath);

    return createAnalysisResponseSchema.parse({
      analysisId: analysis.id,
      status: analysis.status,
    });
  });

  app.post("/api/analyses/:id/process", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const analysis = await getAnalysisById(params.id);

    if (!analysis) {
      return reply.status(404).send({ message: "Analysis not found" });
    }

    await queueAnalysis(params.id);
    const refreshed = await getAnalysisById(params.id);
    if (!refreshed) {
      return reply.status(404).send({ message: "Analysis not found" });
    }

    return createAnalysisResponseSchema.parse({
      analysisId: refreshed.id,
      status: refreshed.status,
    });
  });

  app.post("/api/analyses/:id/cancel", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const analysis = await requestAnalysisCancellation(params.id);

    if (!analysis) {
      return reply.status(404).send({ message: "Analysis not found" });
    }

    return createAnalysisResponseSchema.parse({
      analysisId: analysis.id,
      status: analysis.status,
    });
  });

  app.get("/api/analyses/:id", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const analysis = await getAnalysisById(params.id);
    if (!analysis) {
      return reply.status(404).send({ message: "Analysis not found" });
    }
    return analysisRunSchema.parse(analysis);
  });

  app.get("/api/uploads/:id/file", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const analysis = await getAnalysisById(params.id);
    if (!analysis) {
      return reply.status(404).send({ message: "Analysis not found" });
    }

    const metadata = await readAnalysisMetadata(analysis.id, analysis.storagePath);

    reply.type(metadata.mimeType ?? "application/octet-stream");
    return reply.send(createReadStream(analysis.storagePath));
  });

  return app;
}
