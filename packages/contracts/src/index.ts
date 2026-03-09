import { z } from "zod";

export const sourceTypeSchema = z.enum([
  "upload-image",
  "upload-pdf",
  "url-html",
  "url-pdf",
  "site-crawl",
]);

export const sourceModeSchema = z.enum(["direct", "mapped", "inferred"]);
export const analysisStatusSchema = z.enum([
  "uploaded",
  "queued",
  "processing",
  "completed",
  "failed",
]);
export const providerAvailabilitySchema = z.enum(["enabled", "disabled", "degraded"]);

export const tasteVectorSchema = z.object({
  body: z.number().int().min(1).max(10),
  acidity: z.number().int().min(1).max(10),
  tannin: z.number().int().min(1).max(10),
  sweetness: z.number().int().min(1).max(10),
  sourceMode: sourceModeSchema,
  confidence: z.number().min(0).max(1),
});

export const tasteWeightsSchema = z.object({
  body: z.number().min(0).max(1),
  acidity: z.number().min(0).max(1),
  tannin: z.number().min(0).max(1),
  sweetness: z.number().min(0).max(1),
});

export const userTastePreferenceSchema = z.object({
  body: z.number().int().min(1).max(10),
  acidity: z.number().int().min(1).max(10),
  tannin: z.number().int().min(1).max(10),
  sweetness: z.number().int().min(1).max(10),
  weights: tasteWeightsSchema,
});

export const wineCandidateSchema = z.object({
  id: z.string(),
  rawText: z.string(),
  price: z.string().nullable().default(null),
  lineNumber: z.number().int().nonnegative(),
  producer: z.string().nullable(),
  label: z.string().nullable(),
  vintage: z.number().int().min(1900).max(2100).nullable(),
  color: z.string().nullable(),
  varietal: z.string().nullable(),
  region: z.string().nullable(),
  notes: z.string().nullable().optional(),
  extractionConfidence: z.number().min(0).max(1),
});

export const wineMatchSchema = z.object({
  provider: z.string(),
  providerWineId: z.string(),
  matchedName: z.string(),
  sourceUrl: z.string().url().nullable(),
  matchConfidence: z.number().min(0).max(1),
  accepted: z.boolean(),
});

export const wineProfileSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  producer: z.string().nullable(),
  label: z.string().nullable(),
  vintage: z.number().int().nullable(),
  region: z.string().nullable(),
  varietal: z.string().nullable(),
  provider: z.string(),
  rating: z.number().min(0).max(5).nullable(),
  provenanceLabel: z.string(),
  taste: tasteVectorSchema,
  fetchedAt: z.string(),
});

export const recommendationSchema = z.object({
  candidateId: z.string(),
  fitScore: z.number().min(0).max(100),
  matchConfidence: z.number().min(0).max(1),
  profile: wineProfileSchema.nullable(),
  status: z.enum(["matched", "low-confidence", "unmatched"]),
});

export const analysisRunSchema = z.object({
  id: z.string(),
  sourceType: sourceTypeSchema,
  sourceFilename: z.string(),
  status: analysisStatusSchema,
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  extractedText: z.string().nullable(),
  candidates: z.array(wineCandidateSchema),
  recommendations: z.array(recommendationSchema),
});

export const providerHealthSchema = z.object({
  name: z.string(),
  availability: providerAvailabilitySchema,
  enabled: z.boolean(),
  detail: z.string(),
});

export const createUploadResponseSchema = z.object({
  analysisId: z.string(),
  status: analysisStatusSchema,
});

export const preferencesResponseSchema = z.object({
  preferences: userTastePreferenceSchema,
});

export type SourceType = z.infer<typeof sourceTypeSchema>;
export type SourceMode = z.infer<typeof sourceModeSchema>;
export type AnalysisStatus = z.infer<typeof analysisStatusSchema>;
export type TasteVector = z.infer<typeof tasteVectorSchema>;
export type UserTastePreference = z.infer<typeof userTastePreferenceSchema>;
export type WineCandidate = z.infer<typeof wineCandidateSchema>;
export type WineMatch = z.infer<typeof wineMatchSchema>;
export type WineProfile = z.infer<typeof wineProfileSchema>;
export type Recommendation = z.infer<typeof recommendationSchema>;
export type AnalysisRun = z.infer<typeof analysisRunSchema>;
export type ProviderHealth = z.infer<typeof providerHealthSchema>;
