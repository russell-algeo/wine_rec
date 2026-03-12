import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserTastePreference, WineCandidate, WineProfile } from "@wine-rec/contracts";

const {
  createWineProfileProvidersMock,
  extractSourceTextMock,
  getPreferencesMock,
  parseWineCandidatesMock,
} = vi.hoisted(() => ({
  createWineProfileProvidersMock: vi.fn(),
  extractSourceTextMock: vi.fn(),
  getPreferencesMock: vi.fn(),
  parseWineCandidatesMock: vi.fn(),
}));

vi.mock("../providers/wine-profiles.js", () => ({
  createWineProfileProviders: createWineProfileProvidersMock,
}));

vi.mock("./source-extractor.js", () => ({
  extractSourceText: extractSourceTextMock,
}));

vi.mock("./parser.js", () => ({
  parseWineCandidates: parseWineCandidatesMock,
}));

vi.mock("./repository.js", () => ({
  getPreferences: getPreferencesMock,
}));

import { AnalysisCanceledError, runAnalysisPipeline } from "./pipeline.js";

const defaultPreferences: UserTastePreference = {
  body: 3,
  acidity: 5,
  tannin: 3,
  sweetness: 1,
  weights: {
    body: 0.1,
    acidity: 0.4,
    tannin: 0.1,
    sweetness: 0.4,
  },
};

function buildProfile(overrides: Partial<WineProfile> = {}): WineProfile {
  return {
    id: "profile-1",
    displayName: "Cardedu Praja",
    producer: "Cardedu",
    label: "Praja",
    vintage: 2022,
    region: "Sardegna",
    varietal: "Monica",
    provider: "vivino-direct",
    rating: 4.1,
    ratingCount: 82,
    ratingSource: "vintage",
    imageUrl: null,
    provenanceLabel: "Direct",
    taste: {
      body: 3,
      acidity: 4,
      tannin: 2,
      sweetness: 1,
      sourceMode: "direct",
      confidence: 0.9,
    },
    tasteReviewCount: 12,
    tastingNotes: "Cherry, herbs",
    retailPrice: null,
    fetchedAt: "2026-03-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("analysis pipeline progress hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPreferencesMock.mockResolvedValue(defaultPreferences);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports parsed candidates once and recommendation progress after each wine", async () => {
    const candidates: WineCandidate[] = [
      {
        id: "candidate-1",
        rawText: "Cardedu 'Praja' Monica di Sardegna",
        price: "$23.99",
        menuTab: null,
        menuSection: null,
        lineNumber: 0,
        producer: "Cardedu",
        label: "Praja Monica di Sardegna",
        vintage: 2022,
        color: "red",
        varietal: "Monica",
        region: "Sardegna",
        notes: null,
        extractionConfidence: 0.91,
      },
      {
        id: "candidate-2",
        rawText: "Le Babbler Bordeaux",
        price: "$18.00",
        menuTab: null,
        menuSection: null,
        lineNumber: 2,
        producer: "Le Babbler",
        label: "Bordeaux",
        vintage: 2022,
        color: "red",
        varietal: null,
        region: "Bordeaux",
        notes: null,
        extractionConfidence: 0.89,
      },
    ];

    extractSourceTextMock.mockResolvedValue("RAW OCR TEXT");
    parseWineCandidatesMock.mockReturnValue(candidates);

    const lookup = vi
      .fn()
      .mockResolvedValueOnce({
        provider: "vivino-direct",
        matchScore: 0.83,
        profile: buildProfile(),
      })
      .mockResolvedValueOnce({
        provider: "vivino-direct",
        matchScore: 0.77,
        profile: buildProfile({
          id: "profile-2",
          displayName: "Le Babbler Bordeaux",
          producer: "Le Babbler",
          label: "Bordeaux",
          region: "Bordeaux",
          varietal: null,
        }),
      });

    createWineProfileProvidersMock.mockReturnValue([
      {
        name: "vivino-direct",
        isEnabled: true,
        detail: "test",
        lookup,
      },
    ]);

    const parsedEvents: Array<{ extractedText: string; candidates: WineCandidate[] }> = [];
    const processedEvents: Array<{ completed: number; total: number; candidateId: string; savedCandidateIds: string[] }> = [];

    const result = await runAnalysisPipeline(
      {
        sourceType: "upload-image",
        filename: "menu.png",
        mimeType: "image/png",
        storagePath: "/tmp/menu.png",
      },
      {
        onCandidatesParsed: (payload) => {
          parsedEvents.push(payload);
        },
        onCandidateProcessed: (payload) => {
          processedEvents.push({
            completed: payload.completed,
            total: payload.total,
            candidateId: payload.candidate.id,
            savedCandidateIds: payload.recommendations.map(
              (recommendation) => recommendation.candidateId,
            ),
          });
        },
      },
      {
        candidateConcurrency: 1,
      },
    );

    expect(parsedEvents).toEqual([
      {
        extractedText: "RAW OCR TEXT",
        candidates,
      },
    ]);
    expect(processedEvents).toEqual([
      {
        completed: 1,
        total: 2,
        candidateId: "candidate-1",
        savedCandidateIds: ["candidate-1"],
      },
      {
        completed: 2,
        total: 2,
        candidateId: "candidate-2",
        savedCandidateIds: ["candidate-1", "candidate-2"],
      },
    ]);
    expect(result.candidates).toEqual(candidates);
    expect(result.recommendations).toHaveLength(2);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("limits in-flight candidate lookups to the configured concurrency", async () => {
    const candidates: WineCandidate[] = Array.from({ length: 5 }, (_, index) => ({
      id: `candidate-${index + 1}`,
      rawText: `Wine ${index + 1}`,
      price: `$${20 + index}.00`,
      menuTab: null,
      menuSection: null,
      lineNumber: index,
      producer: `Producer ${index + 1}`,
      label: `Label ${index + 1}`,
      vintage: 2022,
      color: "red",
      varietal: null,
      region: null,
      notes: null,
      extractionConfidence: 0.9,
    }));

    extractSourceTextMock.mockResolvedValue("RAW OCR TEXT");
    parseWineCandidatesMock.mockReturnValue(candidates);

    let activeLookups = 0;
    let maxActiveLookups = 0;
    const deferredLookups = candidates.map(() => {
      let release!: () => void;
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });

      return { done, release };
    });

    const lookup = vi.fn(async (candidate: WineCandidate) => {
      activeLookups += 1;
      maxActiveLookups = Math.max(maxActiveLookups, activeLookups);

      const candidateIndex = Number(candidate.id.split("-").at(-1)) - 1;
      await deferredLookups[candidateIndex]!.done;
      activeLookups -= 1;

      return {
        provider: "vivino-direct",
        matchScore: 0.8,
        profile: buildProfile({
          id: `profile-${candidate.id}`,
          displayName: candidate.rawText,
          producer: candidate.producer,
          label: candidate.label,
        }),
      };
    });

    createWineProfileProvidersMock.mockReturnValue([
      {
        name: "vivino-direct",
        isEnabled: true,
        detail: "test",
        lookup,
      },
    ]);

    const pipelinePromise = runAnalysisPipeline(
      {
        sourceType: "upload-image",
        filename: "menu.png",
        mimeType: "image/png",
        storagePath: "/tmp/menu.png",
      },
      {},
      {
        candidateConcurrency: 2,
      },
    );

    await vi.waitFor(() => {
      expect(lookup).toHaveBeenCalledTimes(2);
    });
    expect(maxActiveLookups).toBe(2);

    deferredLookups[0]!.release();
    await vi.waitFor(() => {
      expect(lookup).toHaveBeenCalledTimes(3);
    });

    deferredLookups[1]!.release();
    await vi.waitFor(() => {
      expect(lookup).toHaveBeenCalledTimes(4);
    });

    deferredLookups[2]!.release();
    await vi.waitFor(() => {
      expect(lookup).toHaveBeenCalledTimes(5);
    });

    deferredLookups[3]!.release();
    deferredLookups[4]!.release();

    const result = await pipelinePromise;

    expect(result.recommendations).toHaveLength(5);
    expect(maxActiveLookups).toBe(2);
  });

  it("stops dispatching new candidate lookups after cancellation is requested", async () => {
    const candidates: WineCandidate[] = [
      {
        id: "candidate-1",
        rawText: "Wine 1",
        price: "$21.00",
        menuTab: null,
        menuSection: null,
        lineNumber: 0,
        producer: "Producer 1",
        label: "Label 1",
        vintage: 2022,
        color: "red",
        varietal: null,
        region: null,
        notes: null,
        extractionConfidence: 0.9,
      },
      {
        id: "candidate-2",
        rawText: "Wine 2",
        price: "$22.00",
        menuTab: null,
        menuSection: null,
        lineNumber: 1,
        producer: "Producer 2",
        label: "Label 2",
        vintage: 2022,
        color: "red",
        varietal: null,
        region: null,
        notes: null,
        extractionConfidence: 0.9,
      },
    ];

    extractSourceTextMock.mockResolvedValue("RAW OCR TEXT");
    parseWineCandidatesMock.mockReturnValue(candidates);

    let releaseLookup!: () => void;
    const lookup = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseLookup = resolve;
      });

      return {
        provider: "vivino-direct",
        matchScore: 0.82,
        profile: buildProfile(),
      };
    });

    createWineProfileProvidersMock.mockReturnValue([
      {
        name: "vivino-direct",
        isEnabled: true,
        detail: "test",
        lookup,
      },
    ]);

    let shouldCancel = false;
    const processedCandidateIds: string[] = [];

    const pipelinePromise = runAnalysisPipeline(
      {
        sourceType: "upload-image",
        filename: "menu.png",
        mimeType: "image/png",
        storagePath: "/tmp/menu.png",
      },
      {
        shouldCancel: () => shouldCancel,
        onCandidateProcessed: ({ candidate }) => {
          processedCandidateIds.push(candidate.id);
        },
      },
      {
        candidateConcurrency: 1,
      },
    );

    await vi.waitFor(() => {
      expect(lookup).toHaveBeenCalledTimes(1);
    });

    shouldCancel = true;
    releaseLookup();

    await expect(pipelinePromise).rejects.toThrow(AnalysisCanceledError);

    expect(processedCandidateIds).toEqual([]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
