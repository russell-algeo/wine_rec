import { describe, expect, it, vi } from "vitest";

vi.mock("./redis-client.js", () => ({
  redis: {
    createScript: vi.fn(() => ({ exec: vi.fn() })),
  },
}));

import { normalizeJobRecord, normalizeWineCandidate, parseTransitionResult } from "./job-store.js";

describe("job transition result parsing", () => {
  it("parses serialized script results", () => {
    expect(
      parseTransitionResult(JSON.stringify({
        updated: true,
        progressTracked: true,
        jobStatus: "completed",
      })),
    ).toEqual({
      updated: true,
      progressTracked: true,
      jobStatus: "completed",
    });
  });

  it("accepts already-deserialized script results", () => {
    expect(parseTransitionResult({
      updated: true,
      progressTracked: true,
      jobStatus: "failed",
    })).toEqual({
      updated: true,
      progressTracked: true,
      jobStatus: "failed",
    });
  });
});

describe("job record normalization", () => {
  it("restores missing nullable candidate fields", () => {
    expect(normalizeWineCandidate({
      id: "candidate-1",
      rawText: "Bianchi Chardonnay, Central Coast",
      lineNumber: 6,
      extractionConfidence: 0.88,
      price: undefined as unknown as null,
      menuTab: undefined as unknown as null,
      menuSection: "White Wines",
      producer: "Bianchi Chardonnay",
      label: "Central Coast",
      vintage: undefined as unknown as null,
      color: "white",
      varietal: "chardonnay",
      region: undefined as unknown as null,
      notes: undefined,
    })).toEqual({
      id: "candidate-1",
      rawText: "Bianchi Chardonnay, Central Coast",
      lineNumber: 6,
      extractionConfidence: 0.88,
      price: null,
      menuTab: null,
      menuSection: "White Wines",
      producer: "Bianchi Chardonnay",
      label: "Central Coast",
      vintage: null,
      color: "white",
      varietal: "chardonnay",
      region: null,
      notes: null,
    });
  });

  it("restores missing nullable job fields", () => {
    expect(normalizeJobRecord({
      id: "job-1",
      sourceType: "url-html",
      sourceFilename: "https://example.com/menu",
      status: "processing",
      queueMessageId: undefined as unknown as null,
      errorMessage: undefined as unknown as null,
      extractedText: undefined as unknown as null,
      candidates: [],
      recommendations: undefined as unknown as [],
      workerCount: undefined as unknown as number,
      createdAt: "2026-03-21T20:00:00.000Z",
      updatedAt: "2026-03-21T20:00:00.000Z",
    })).toEqual({
      id: "job-1",
      sourceType: "url-html",
      sourceFilename: "https://example.com/menu",
      status: "processing",
      queueMessageId: null,
      errorMessage: null,
      extractedText: null,
      candidates: [],
      recommendations: [],
      workerCount: 0,
      createdAt: "2026-03-21T20:00:00.000Z",
      updatedAt: "2026-03-21T20:00:00.000Z",
    });
  });
});
