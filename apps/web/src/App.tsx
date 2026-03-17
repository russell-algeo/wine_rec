import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { SnapController } from './snap-controller';
import { SnapNav } from './SnapNav';

import type {
  AnalysisRun,
  CreateAnalysisResponse,
  TasteVector,
  UserTastePreference,
  WineRatingSource,
} from "@wine-rec/contracts";

const apiBaseUrl =
  import.meta.env.VITE_API_BASE_URL ??
  (import.meta.env.PROD
    ? ""
    : `${window.location.protocol}//${window.location.hostname}:3001`);

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

function loadPreferences(): UserTastePreference {
  try {
    const stored = window.localStorage.getItem("wine-rec-preferences");
    return stored ? JSON.parse(stored) as UserTastePreference : defaultPreferences;
  } catch {
    return defaultPreferences;
  }
}

function writePreferencesJson(preferences: UserTastePreference): void {
  window.localStorage.setItem("wine-rec-preferences", JSON.stringify(preferences));
}

function storePreferences(preferences: UserTastePreference): void {
  window.localStorage.setItem("wine-rec-preferences", JSON.stringify(preferences));
  window.localStorage.setItem("wine-rec-has-preferences", "true");
}

function hasStoredPreferencesFlag(): boolean {
  try {
    return (
      window.localStorage.getItem("wine-rec-has-preferences") === "true" ||
      window.localStorage.getItem("wine-rec-preferences") !== null
    );
  } catch {
    return false;
  }
}

function preferencesEqual(left: UserTastePreference, right: UserTastePreference): boolean {
  return (
    left.body === right.body &&
    left.acidity === right.acidity &&
    left.tannin === right.tannin &&
    left.sweetness === right.sweetness &&
    left.weights.body === right.weights.body &&
    left.weights.acidity === right.weights.acidity &&
    left.weights.tannin === right.weights.tannin &&
    left.weights.sweetness === right.weights.sweetness
  );
}

function scoreRecommendation(preference: UserTastePreference, taste: TasteVector): number {
  const weightedDistance =
    Math.abs(preference.body - taste.body) * preference.weights.body +
    Math.abs(preference.acidity - taste.acidity) * preference.weights.acidity +
    Math.abs(preference.tannin - taste.tannin) * preference.weights.tannin +
    Math.abs(preference.sweetness - taste.sweetness) * preference.weights.sweetness;
  const maxDistance =
    4 * preference.weights.body +
    4 * preference.weights.acidity +
    4 * preference.weights.tannin +
    4 * preference.weights.sweetness;
  if (maxDistance === 0) return 100;
  return Math.max(0, Math.min(100, Math.round((1 - weightedDistance / maxDistance) * 100)));
}

type AnalysisState = {
  analysisId: string;
  status: AnalysisRun["status"];
};

type ResultSortOrder = "recommended" | "discovered";
type ResultProfileFilter = "all" | "exclude-inferred";
type ResultRecommendation = AnalysisRun["recommendations"][number];
type ResultCandidate = AnalysisRun["candidates"][number];
type ResultWineProfile = NonNullable<ResultRecommendation["profile"]>;
type ResultTastingNoteGroup = NonNullable<ResultWineProfile["tastingNoteGroups"]>[number];
type ResultSection = {
  id: string;
  label: string;
  menuTab: string | null;
  menuSection: string | null;
  recommendations: ResultRecommendation[];
};
type TasteScaleTone = "default" | "uncertain";
type AnalysisProgress = {
  title: string;
  detail: string;
  processed: number;
  total: number;
  fraction: number | null;
  status: AnalysisRun["status"];
};
type PriceFilterBounds = {
  min: number;
  max: number;
  pricedCount: number;
  missingCount: number;
};
type TastingNoteIconName = "berries" | "loaf" | "citrus" | "flower" | "leaf" | "barrel" | "spark";
type TastingNoteVisual = {
  accent: string;
  accentSoft: string;
  badge: string;
  surface: string;
  icon: TastingNoteIconName;
};

type TasteDimension = "body" | "tannin" | "sweetness" | "acidity";

const tasteDimensionOrder: TasteDimension[] = ["body", "tannin", "sweetness", "acidity"];
const allResultSectionsId = "__all_sections__";
const terminalAnalysisStatuses = new Set<AnalysisRun["status"]>(["canceled", "completed", "failed"]);
const analysisPollingIntervalMs = 2500;
const analysisPollingStaleAfterMs = 75_000;
const ratingFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const ratingCountFormatter = new Intl.NumberFormat();
const tastingNoteVisuals: Record<string, TastingNoteVisual> = {
  "red-fruit": {
    accent: "#c93b32",
    accentSoft: "#df6558",
    badge: "rgba(255, 255, 255, 0.16)",
    surface: "rgba(201, 59, 50, 0.12)",
    icon: "berries",
  },
  "black-fruit": {
    accent: "#32428d",
    accentSoft: "#5364b9",
    badge: "rgba(255, 255, 255, 0.14)",
    surface: "rgba(50, 66, 141, 0.12)",
    icon: "berries",
  },
  yeasty: {
    accent: "#c48849",
    accentSoft: "#d8a46e",
    badge: "rgba(255, 255, 255, 0.14)",
    surface: "rgba(196, 136, 73, 0.14)",
    icon: "loaf",
  },
  microbio: {
    accent: "#c48849",
    accentSoft: "#d8a46e",
    badge: "rgba(255, 255, 255, 0.14)",
    surface: "rgba(196, 136, 73, 0.14)",
    icon: "loaf",
  },
  "citrus-fruit": {
    accent: "#d59f33",
    accentSoft: "#e4bf62",
    badge: "rgba(255, 255, 255, 0.14)",
    surface: "rgba(213, 159, 51, 0.14)",
    icon: "citrus",
  },
  "tree-fruit": {
    accent: "#7c9c53",
    accentSoft: "#98b56d",
    badge: "rgba(255, 255, 255, 0.14)",
    surface: "rgba(124, 156, 83, 0.14)",
    icon: "leaf",
  },
  "tropical-fruit": {
    accent: "#da8d3c",
    accentSoft: "#ebb268",
    badge: "rgba(255, 255, 255, 0.14)",
    surface: "rgba(218, 141, 60, 0.14)",
    icon: "citrus",
  },
  floral: {
    accent: "#b56286",
    accentSoft: "#cf88a7",
    badge: "rgba(255, 255, 255, 0.14)",
    surface: "rgba(181, 98, 134, 0.14)",
    icon: "flower",
  },
  earth: {
    accent: "#705b48",
    accentSoft: "#92755d",
    badge: "rgba(255, 255, 255, 0.14)",
    surface: "rgba(112, 91, 72, 0.14)",
    icon: "leaf",
  },
  oak: {
    accent: "#956038",
    accentSoft: "#b98559",
    badge: "rgba(255, 255, 255, 0.14)",
    surface: "rgba(149, 96, 56, 0.14)",
    icon: "barrel",
  },
  spices: {
    accent: "#9f5336",
    accentSoft: "#bf7a5a",
    badge: "rgba(255, 255, 255, 0.14)",
    surface: "rgba(159, 83, 54, 0.14)",
    icon: "barrel",
  },
};
const defaultTastingNoteVisual: TastingNoteVisual = {
  accent: "#7f6550",
  accentSoft: "#9a7b63",
  badge: "rgba(255, 255, 255, 0.14)",
  surface: "rgba(127, 101, 80, 0.14)",
  icon: "spark",
};

const tasteScaleCopy: Record<
  TasteDimension,
  {
    label: string;
    low: string;
    high: string;
  }
> = {
  body: {
    label: "Body",
    low: "Light",
    high: "Bold",
  },
  tannin: {
    label: "Tannin",
    low: "Smooth",
    high: "Tannic",
  },
  sweetness: {
    label: "Sweetness",
    low: "Dry",
    high: "Sweet",
  },
  acidity: {
    label: "Acidity",
    low: "Soft",
    high: "Acidic",
  },
};

async function getJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${input}`, init);
  if (!response.ok) {
    let message = "";
    const contentType = response.headers.get("content-type") ?? "";

    if (contentType.includes("application/json")) {
      try {
        const payload = await response.json() as { message?: string; error?: string };
        message = payload.message ?? payload.error ?? "";
      } catch {
        message = "";
      }
    } else {
      try {
        message = (await response.text()).trim();
      } catch {
        message = "";
      }
    }

    throw new Error(message || `Request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function sortRecommendations(
  recommendations: AnalysisRun["recommendations"],
  candidates: AnalysisRun["candidates"],
  sortOrder: ResultSortOrder,
): AnalysisRun["recommendations"] {
  if (sortOrder === "recommended") {
    return [...recommendations].sort((a, b) =>
      b.fitScore !== a.fitScore
        ? b.fitScore - a.fitScore
        : b.matchConfidence - a.matchConfidence,
    );
  }

  const discoveredOrder = new Map(
    candidates.map((candidate, index) => [candidate.id, index]),
  );
  const rankedOrder = new Map(
    recommendations.map((recommendation, index) => [recommendation.candidateId, index]),
  );

  return [...recommendations].sort((left, right) => {
    const leftDiscovered = discoveredOrder.get(left.candidateId) ?? Number.MAX_SAFE_INTEGER;
    const rightDiscovered = discoveredOrder.get(right.candidateId) ?? Number.MAX_SAFE_INTEGER;

    if (leftDiscovered !== rightDiscovered) {
      return leftDiscovered - rightDiscovered;
    }

    return (
      (rankedOrder.get(left.candidateId) ?? Number.MAX_SAFE_INTEGER) -
      (rankedOrder.get(right.candidateId) ?? Number.MAX_SAFE_INTEGER)
    );
  });
}

export function App() {
  const [preferences, setPreferences] = useState<UserTastePreference>(() => loadPreferences());
  const [loadedPreferences, setLoadedPreferences] = useState<UserTastePreference>(() => loadPreferences());
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [analysisState, setAnalysisState] = useState<AnalysisState | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisRun | null>(null);
  const [analysisNotice, setAnalysisNotice] = useState<string | null>(null);
  const [resultSortOrder, setResultSortOrder] = useState<ResultSortOrder>("recommended");
  const [resultProfileFilter, setResultProfileFilter] = useState<ResultProfileFilter>("exclude-inferred");
  const [selectedResultSectionId, setSelectedResultSectionId] = useState(allResultSectionsId);
  const [maxPriceFilter, setMaxPriceFilter] = useState<number | null>(null);
  const [includePriceUnavailable, setIncludePriceUnavailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [pollingPaused, setPollingPaused] = useState(false);
  const [tastePanelOpen, setTastePanelOpen] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [filePreviewUrl, setFilePreviewUrl] = useState<string | null>(null);
  const [urlPreview, setUrlPreview] = useState<{ title: string | null; domain: string } | null>(null);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [onboardingStep, setOnboardingStep] = useState<1 | 2>(1);
  const [stepTwoIsConfirmMode, setStepTwoIsConfirmMode] = useState(false);
  const [inNewAnalysisFlow, setInNewAnalysisFlow] = useState(false);
  const [urlFetching, setUrlFetching] = useState(false);
  const [resultsTastePanelOpen, setResultsTastePanelOpen] = useState(false);
  const [showRerankFlash, setShowRerankFlash] = useState(false);
  const [additionalFiltersOpen, setAdditionalFiltersOpen] = useState(false);
  const [hasStoredPreferences, setHasStoredPreferences] = useState(() => hasStoredPreferencesFlag());
  const [currentPane, setCurrentPane] = useState(0);
  const snapControllerRef = useRef<SnapController | null>(null);
  const [modalPreferences, setModalPreferences] = useState<Record<TasteDimension, number | null>>(
    () => {
      try {
        if (hasStoredPreferencesFlag()) {
          const stored = loadPreferences();
          return { body: stored.body, tannin: stored.tannin, sweetness: stored.sweetness, acidity: stored.acidity };
        }
      } catch {
        // fall through to null state
      }
      return { body: null, tannin: null, sweetness: null, acidity: null };
    }
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isLiveReranking = Boolean(analysis && !preferencesEqual(preferences, loadedPreferences));
  const baseRecommendations = isLiveReranking && analysis
    ? [...analysis.recommendations]
        .map((rec) => ({
          ...rec,
          fitScore: rec.profile ? scoreRecommendation(preferences, rec.profile.taste) : rec.fitScore,
        }))
        .sort((a, b) => b.fitScore !== a.fitScore ? b.fitScore - a.fitScore : b.matchConfidence - a.matchConfidence)
    : analysis?.recommendations ?? [];
  const sortedRecommendations = analysis
    ? sortRecommendations(baseRecommendations, analysis.candidates, resultSortOrder)
    : [];
  const inferredRecommendationCount = sortedRecommendations.filter(isInferredRecommendation).length;
  const priceFilterBounds = getPriceFilterBounds(analysis?.candidates ?? []);
  const effectiveMaxPrice = priceFilterBounds ? (maxPriceFilter ?? priceFilterBounds.max) : null;
  const isPriceFilterActive = Boolean(
    priceFilterBounds &&
      effectiveMaxPrice != null &&
      (
        effectiveMaxPrice < priceFilterBounds.max ||
        (!includePriceUnavailable && priceFilterBounds.missingCount > 0)
      ),
  );
  const profileFilteredRecommendations = filterRecommendationsByProfileSource(
    sortedRecommendations,
    resultProfileFilter,
  );
  const candidateById = analysis
    ? new Map(analysis.candidates.map((candidate) => [candidate.id, candidate]))
    : new Map<string, ResultCandidate>();
  const filteredRecommendations = filterRecommendationsByPrice(
    profileFilteredRecommendations,
    candidateById,
    effectiveMaxPrice,
    includePriceUnavailable,
  );
  const hiddenByPriceCount = profileFilteredRecommendations.length - filteredRecommendations.length;
  const resultSections = buildResultSections(analysis, filteredRecommendations, candidateById);
  const hasStructuredResults = resultSections.some((section) => section.menuTab || section.menuSection);
  const visibleResultSections =
    selectedResultSectionId === allResultSectionsId
      ? resultSections
      : resultSections.filter((section) => section.id === selectedResultSectionId);
  const analysisProgress = getAnalysisProgress(analysis);
  const hasActiveAnalysis = Boolean(
    analysisState && !terminalAnalysisStatuses.has(analysisState.status),
  );

  function updatePreference(dimension: TasteDimension, value: number) {
    setHasStoredPreferences(true);
    setPreferences((current) => {
      if (dimension === "body") {
        return { ...current, body: value };
      }

      if (dimension === "tannin") {
        return { ...current, tannin: value };
      }

      if (dimension === "sweetness") {
        return { ...current, sweetness: value };
      }

      return { ...current, acidity: value };
    });
  }

  useEffect(() => {
    const controller = new SnapController(setCurrentPane);
    snapControllerRef.current = controller;
    controller.init();
    return () => controller.destroy();
  }, []);

  useEffect(() => {
    return () => {
      if (filePreviewUrl) URL.revokeObjectURL(filePreviewUrl);
    };
  }, [filePreviewUrl]);

  useEffect(() => {
    writePreferencesJson(preferences);
    if (!analysis) {
      setLoadedPreferences(preferences);
    }
  }, [analysis, preferences]);

  useEffect(() => {
    if (!isLiveReranking) return;
    setShowRerankFlash(true);
    const timer = setTimeout(() => setShowRerankFlash(false), 1500);
    return () => clearTimeout(timer);
  }, [isLiveReranking, preferences]);

  useEffect(() => {
    if (!analysisState || terminalAnalysisStatuses.has(analysisState.status) || pollingPaused) {
      return;
    }

    const handle = window.setTimeout(() => {
      void getJson<AnalysisRun>(`/api/analyses/${analysisState.analysisId}`)
        .then((response) => {
          setAnalysis(response);
          setAnalysisState({ analysisId: response.id, status: response.status });

          if (terminalAnalysisStatuses.has(response.status)) {
            setPollingPaused(false);
            setAnalysisNotice(null);
            return;
          }

          const updatedAtMs = Date.parse(response.updatedAt);
          if (Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs >= analysisPollingStaleAfterMs) {
            setPollingPaused(true);
            setAnalysisNotice(
              "Analysis looks stalled. Polling paused to conserve usage. Resume polling or stop this run.",
            );
            return;
          }

          setAnalysisNotice(null);
        })
        .catch((cause) => {
          setPollingPaused(true);
          setAnalysisNotice("Live updates paused after a refresh error. Resume polling or stop this run.");
          setError(cause instanceof Error ? cause.message : "Failed to refresh analysis");
        });
    }, analysisPollingIntervalMs);

    return () => window.clearTimeout(handle);
  }, [analysisState, pollingPaused]);

  useEffect(() => {
    if (
      selectedResultSectionId !== allResultSectionsId &&
      !resultSections.some((section) => section.id === selectedResultSectionId)
    ) {
      setSelectedResultSectionId(allResultSectionsId);
    }
  }, [resultSections, selectedResultSectionId]);

  useEffect(() => {
    setMaxPriceFilter(null);
    setIncludePriceUnavailable(true);
  }, [analysis?.id]);

  useEffect(() => {
    const normalized = normalizeUrlInput(sourceUrl);
    if (!normalized) {
      setUrlPreview(null);
      setPendingUrl(null);
      return;
    }
    const timer = setTimeout(async () => {
      setUrlFetching(true);
      try {
        const preview = await getJson<{ title: string | null; domain: string }>(
          `/api/preview?url=${encodeURIComponent(normalized)}`
        );
        setUrlPreview(preview);
        setPendingUrl(normalized);
      } catch {
        try {
          const domain = new URL(normalized).hostname;
          setUrlPreview({ title: null, domain });
          setPendingUrl(normalized);
        } catch {
          // Not yet a valid URL — leave preview unchanged
        }
      } finally {
        setUrlFetching(false);
      }
    }, 700);
    return () => clearTimeout(timer);
  }, [sourceUrl]);

  async function handleUpload() {
    if (!selectedFile) {
      setError("Choose an image or PDF first.");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.set("file", selectedFile);

      const upload = await getJson<CreateAnalysisResponse>("/api/uploads", {
        method: "POST",
        body: formData,
      });

      await launchAnalysis(upload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleUrlAnalyze() {
    if (!pendingUrl) return;

    setBusy(true);
    setError(null);

    try {
      const created = await getJson<CreateAnalysisResponse>("/api/urls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: pendingUrl }),
      });
      setSourceUrl(pendingUrl);
      await launchAnalysis(created);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to start analysis");
    } finally {
      setBusy(false);
    }
  }

  async function handleIngestAnalyze() {
    const allSet = tasteDimensionOrder.every((d) => modalPreferences[d] !== null);
    if (!allSet) return;
    const confirmedPrefs: UserTastePreference = {
      ...loadPreferences(),
      body: modalPreferences.body!,
      tannin: modalPreferences.tannin!,
      sweetness: modalPreferences.sweetness!,
      acidity: modalPreferences.acidity!,
    };
    setPreferences(confirmedPrefs);
    prepareAnalysis(confirmedPrefs);
    try {
      if (selectedFile) {
        await handleUpload();
      } else if (pendingUrl) {
        await handleUrlAnalyze();
      }
    } catch {
      // handleUpload / handleUrlAnalyze manage their own error state
    }
    setInNewAnalysisFlow(false);
  }

  function handleNewAnalysis() {
    setOnboardingStep(1);
    setStepTwoIsConfirmMode(false);
    setError(null);
    setInNewAnalysisFlow(true);
    setSourceUrl("");
    setUrlPreview(null);
    setPendingUrl(null);
    setSelectedFile(null);
    if (filePreviewUrl) URL.revokeObjectURL(filePreviewUrl);
    setFilePreviewUrl(null);
  }

  function clearAnalysisState() {
    setAnalysisState(null);
    setAnalysis(null);
    setUrlPreview(null);
    setPendingUrl(null);
    setSelectedFile(null);
    if (filePreviewUrl) URL.revokeObjectURL(filePreviewUrl);
    setFilePreviewUrl(null);
    setSourceUrl("");
    setError(null);
  }

  function prepareAnalysis(prefsToUse?: UserTastePreference) {
    const prefs = prefsToUse ?? preferences;
    storePreferences(prefs);
    setHasStoredPreferences(true);
    setLoadedPreferences(prefs);
    setAnalysisNotice(null);
    setPollingPaused(false);
  }

  async function launchAnalysis(next: CreateAnalysisResponse) {
    clearAnalysisState();
    const nextAnalysis = await getJson<AnalysisRun>(`/api/analyses/${next.analysisId}`);
    setAnalysisState({ analysisId: next.analysisId, status: nextAnalysis.status });
    setAnalysis(nextAnalysis);
    setAnalysisNotice(null);
    setPollingPaused(false);
    // Keep the setTimeout so React has flushed initial results state before we
    // snap. The 50ms delay also ensures the ResizeObserver has had a chance to
    // recompute snapPositions[2] if the results container changed size.
    setTimeout(() => {
      snapControllerRef.current?.snapTo(2);
    }, 50);
  }

  function resumePolling() {
    setError(null);
    setAnalysisNotice(null);
    setPollingPaused(false);
  }

  async function handleCancelAnalysis() {
    if (!analysisState) {
      return;
    }

    setCancelBusy(true);
    setError(null);
    setAnalysisNotice(null);

    try {
      const canceled = await getJson<AnalysisRun>(`/api/analyses/${analysisState.analysisId}/cancel`, {
        method: "POST",
      });
      setAnalysis(canceled);
      setAnalysisState({ analysisId: canceled.id, status: canceled.status });
      setPollingPaused(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to stop analysis");
    } finally {
      setCancelBusy(false);
    }
  }

  function handleDropZoneClick() {
    fileInputRef.current?.click();
  }

  function handleFileChange(file: File | null) {
    if (filePreviewUrl) {
      URL.revokeObjectURL(filePreviewUrl);
    }
    setSelectedFile(file);
    setUrlPreview(null);
    setPendingUrl(null);
    if (file) {
      setFilePreviewUrl(URL.createObjectURL(file));
    } else {
      setFilePreviewUrl(null);
    }
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    setIsDragOver(false);
    const file = event.dataTransfer.files[0] ?? null;
    if (file) {
      handleFileChange(file);
    }
  }

  function handleDragOver(event: React.DragEvent) {
    event.preventDefault();
    setIsDragOver(true);
  }

  function handleDragLeave() {
    setIsDragOver(false);
  }

  function resetIngestFlow() {
    if (hasStoredPreferences) {
      const stored = loadPreferences();
      setModalPreferences({ body: stored.body, tannin: stored.tannin, sweetness: stored.sweetness, acidity: stored.acidity });
    } else {
      setModalPreferences({ body: null, tannin: null, sweetness: null, acidity: null });
    }
    setUrlPreview(null);
    setPendingUrl(null);
    setSourceUrl("");
    setSelectedFile(null);
    if (filePreviewUrl) URL.revokeObjectURL(filePreviewUrl);
    setFilePreviewUrl(null);
    setError(null);
  }

  function scrollToIngest() {
    snapControllerRef.current?.snapTo(1);
  }

  function scrollToResults() {
    snapControllerRef.current?.snapTo(2);
  }

  function updateModalPreference(dimension: TasteDimension, value: number) {
    setModalPreferences((prev) => ({ ...prev, [dimension]: value }));
  }

  const step1Ready = Boolean(urlPreview || selectedFile);
  const step2Ready = tasteDimensionOrder.every((d) => modalPreferences[d] !== null);

  return (
    <div className="page-shell">
      <SnapNav
        currentPane={currentPane}
        onSnap={(pane) => snapControllerRef.current?.snapTo(pane as 0 | 1 | 2)}
      />
      {/* ── Sticky nav ── */}
      <nav className="site-nav">
        <span className="site-nav-brand">Wine Rec</span>
        <button
          className="site-nav-toggle"
          onClick={() => setTastePanelOpen((open) => !open)}
          type="button"
        >
          {tastePanelOpen ? "Close" : "My Taste"}
        </button>
      </nav>

      {/* ── Taste preferences dropdown ── */}
      {tastePanelOpen ? (
        <div className="taste-panel">
          <div className="taste-panel-inner">
            <p className="taste-profile-title">How should your wine taste?</p>
            <div className="taste-scale-stack">
              {tasteDimensionOrder.map((dimension) => (
                <TasteScale
                  dimension={dimension}
                  key={dimension}
                  onChange={(value) => updatePreference(dimension, value)}
                  value={preferences[dimension]}
                />
              ))}
            </div>
            <p className={`taste-panel-hint${showRerankFlash ? " is-rerank-flash" : ""}`}>
              {showRerankFlash ? "✓ Updated" : "Adjust your preferences to automatically re-rank wines."}
            </p>
          </div>
        </div>
      ) : null}

      <main className="page">
        {/* ── Hero ── */}
        <section className="hero-card">
          <h1>WINE REC</h1>
          <p className="lede">
            Find the best bottle on any wine list.
          </p>
          <button className="hero-cta" onClick={scrollToIngest} type="button">
            Get Started
          </button>
        </section>

        {/* ── Ingest section ── */}
        <section className="ingest-section" id="ingest">
          <div className="onboarding-card">

            {/* Step indicator */}
            <div className="onboarding-dots">
              <div className={`onboarding-dot ${onboardingStep === 1 ? "is-active" : "is-done"}`} />
              <div className={`onboarding-dot ${onboardingStep === 2 ? "is-active" : "is-idle"}`} />
            </div>

            {/* Step 1 */}
            {onboardingStep === 1 && (
              <div className="onboarding-step-body">
                <h2>What&rsquo;s on the list?</h2>
                <p className="section-copy">Paste a link or snap a photo of any wine list.</p>

                <div className="url-row">
                  <input
                    className="url-row-input"
                    onChange={(e) => setSourceUrl(e.target.value)}
                    placeholder="Paste a wine list URL"
                    type="url"
                    value={sourceUrl}
                  />
                </div>
                {urlFetching && <p className="url-fetching-hint">Checking link…</p>}

                {urlPreview && (
                  <div className="url-preview-card">
                    <img
                      alt={`${urlPreview.domain} favicon`}
                      className="url-preview-favicon"
                      src={`https://www.google.com/s2/favicons?domain=${urlPreview.domain}&sz=32`}
                    />
                    <div className="url-preview-meta">
                      <span className="url-preview-title">{urlPreview.title ?? urlPreview.domain}</span>
                      <span className="url-preview-domain">{urlPreview.domain}</span>
                    </div>
                    <span className="url-preview-check" aria-label="URL confirmed">✓</span>
                  </div>
                )}

                <div className="ingest-divider"><span>or</span></div>

                <div
                  className={`drop-zone${isDragOver ? " is-dragover" : ""}${selectedFile ? " has-file" : ""}`}
                  onClick={handleDropZoneClick}
                  onDragLeave={handleDragLeave}
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                >
                  <input
                    accept="image/*,application/pdf"
                    className="drop-zone-input"
                    onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
                    ref={fileInputRef}
                    type="file"
                  />
                  {selectedFile ? (
                    <div className="drop-zone-file-row">
                      <div className="drop-zone-thumbnail-wrap">
                        {filePreviewUrl && (
                          <img
                            alt="Selected file preview"
                            className="drop-zone-thumbnail"
                            src={filePreviewUrl}
                          />
                        )}
                        <div className="drop-zone-image-badge">
                          <span className="drop-zone-filesize">
                            {(selectedFile.size / 1024 / 1024).toFixed(1)} MB
                          </span>
                          <button
                            className="drop-zone-clear"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleFileChange(null);
                            }}
                            type="button"
                            aria-label="Remove selected file"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                      <p className="drop-zone-filename">{selectedFile.name}</p>
                    </div>
                  ) : (
                    <div className="drop-zone-prompt">
                      <span className="drop-zone-icon" aria-hidden="true">
                        <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" viewBox="0 0 24 24" width="32" height="32">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="17 8 12 3 7 8" />
                          <line x1="12" x2="12" y1="3" y2="15" />
                        </svg>
                      </span>
                      <p className="drop-zone-label">Drop a photo, screenshot, or PDF here</p>
                      <p className="drop-zone-hint">or click to browse</p>
                    </div>
                  )}
                </div>

                {error && <p className="error">{error}</p>}

                <div className="onboarding-footer">
                  <button
                    className="action"
                    disabled={!step1Ready}
                    onClick={() => {
                      if (hasStoredPreferences) {
                        setModalPreferences((current) =>
                          tasteDimensionOrder.reduce(
                            (acc, d) => ({ ...acc, [d]: current[d] ?? preferences[d] }),
                            current
                          )
                        );
                      }
                      setStepTwoIsConfirmMode(hasStoredPreferences || tasteDimensionOrder.every((d) => modalPreferences[d] !== null));
                      setOnboardingStep(2);
                    }}
                    type="button"
                  >
                    {urlFetching ? <span className="btn-spinner" aria-hidden="true" /> : "Next →"}
                  </button>
                </div>
              </div>
            )}

            {/* Step 2 */}
            {onboardingStep === 2 && (
              <div className="onboarding-step-body">
                <h2>{stepTwoIsConfirmMode ? "Confirm your preferences" : "How do you like your wine?"}</h2>
                <p className="section-copy">
                  {stepTwoIsConfirmMode
                    ? "Adjust if you'd like, then analyze."
                    : "Drag each slider — results are ranked to match your taste."}
                </p>

                <div className="taste-scale-stack">
                  {tasteDimensionOrder.map((dimension) => (
                    <TasteScale
                      dimension={dimension}
                      key={dimension}
                      onChange={(value) => updateModalPreference(dimension, value)}
                      value={modalPreferences[dimension]}
                    />
                  ))}
                </div>

                {error && <p className="error">{error}</p>}

                <div className="onboarding-footer">
                  {hasActiveAnalysis ? (
                    <button
                      className="action"
                      onClick={() => { handleNewAnalysis(); scrollToIngest(); }}
                      type="button"
                    >
                      New Analysis
                    </button>
                  ) : inNewAnalysisFlow ? (
                    <>
                      <button
                        className="onboarding-btn-cancel"
                        onClick={() => setOnboardingStep(1)}
                        style={{ marginRight: "auto" }}
                        type="button"
                      >
                        ← Back
                      </button>
                      <button
                        className="action onboarding-btn-analyze"
                        disabled={!step2Ready || busy}
                        onClick={() => void handleIngestAnalyze()}
                        type="button"
                      >
                        {busy ? "Starting…" : "Analyze →"}
                      </button>
                    </>
                  ) : analysis ? (
                    <>
                      <button
                        className="action"
                        onClick={() => { handleNewAnalysis(); scrollToIngest(); }}
                        style={{ marginRight: "auto" }}
                        type="button"
                      >
                        New Analysis
                      </button>
                      <button
                        className="action"
                        onClick={scrollToResults}
                        type="button"
                      >
                        See Results →
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="onboarding-btn-cancel"
                        onClick={() => setOnboardingStep(1)}
                        style={{ marginRight: "auto" }}
                        type="button"
                      >
                        ← Back
                      </button>
                      <button
                        className="action onboarding-btn-analyze"
                        disabled={!step2Ready || busy}
                        onClick={() => void handleIngestAnalyze()}
                        type="button"
                      >
                        {busy ? "Starting…" : "Analyze →"}
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}

          </div>
        </section>

        {/* ── Analysis progress / status ── */}
        {error ? <p className="error">{error}</p> : null}
        {analysisNotice ? <p className="helper">{analysisNotice}</p> : null}

        {/* ── Image break: bottles on concrete ── */}
        <section className="image-break image-break-bottles">
          <h2 className="image-break-text">
            Every list.<br />Every bottle.<br />Ranked for you.
          </h2>
        </section>

        {/* ── Results ── */}
        <section id="results" className="stack">
          <div className="panel">
            {analysis && (
              <>
                <div className="results-action-row">
                  <button
                    className="action"
                    onClick={() => setResultsTastePanelOpen((open) => !open)}
                    type="button"
                  >
                    Adjust Preferences
                  </button>
                  {hasActiveAnalysis ? (
                    <button
                      className="action action-danger"
                      disabled={cancelBusy}
                      onClick={() => void handleCancelAnalysis()}
                      type="button"
                    >
                      {cancelBusy ? "Stopping…" : "Stop Analysis"}
                    </button>
                  ) : (
                    <button
                      className="action action-danger"
                      onClick={() => { handleNewAnalysis(); scrollToIngest(); }}
                      type="button"
                    >
                      New Analysis
                    </button>
                  )}
                </div>
                {resultsTastePanelOpen && (
                  <div className="result-taste-panel">
                    <div className="taste-scale-stack">
                      {tasteDimensionOrder.map((dimension) => (
                        <TasteScale
                          dimension={dimension}
                          key={dimension}
                          onChange={(value) => updatePreference(dimension, value)}
                          value={preferences[dimension]}
                        />
                      ))}
                    </div>
                    <p className={`result-taste-panel-hint${showRerankFlash ? " is-rerank-flash" : ""}`}>
                      {showRerankFlash ? "✓ Rankings updated" : "Adjust your preferences to automatically re-rank wines."}
                    </p>
                  </div>
                )}
              </>
            )}
            <div className="result-header">
              <h2>Results</h2>
              {analysis?.recommendations.length ? (
                <div className="result-controls">
                  <div className="result-control-group">
                    <span>Sort by</span>
                    <div aria-label="Sort results" className="sort-toggle" role="group">
                      <button
                        className={`sort-option${resultSortOrder === "recommended" ? " is-active" : ""}`}
                        onClick={() => setResultSortOrder("recommended")}
                        type="button"
                      >
                        Best fit
                      </button>
                      <button
                        className={`sort-option${resultSortOrder === "discovered" ? " is-active" : ""}`}
                        onClick={() => setResultSortOrder("discovered")}
                        type="button"
                      >
                        Menu order
                      </button>
                    </div>
                  </div>
                  <button
                    className="result-extra-filters-toggle"
                    onClick={() => setAdditionalFiltersOpen((o) => !o)}
                    type="button"
                  >
                    Filters
                    <svg aria-hidden="true" fill="none" height="10" viewBox="0 0 10 10" width="10">
                      <path d={additionalFiltersOpen ? "M1 7L5 3L9 7" : "M1 3L5 7L9 3"} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
                    </svg>
                  </button>
                  <div className={`result-controls-extra${additionalFiltersOpen ? " is-open" : ""}`}>
                    {priceFilterBounds && effectiveMaxPrice != null ? (
                      <div className="result-control-group result-control-group-budget">
                        <span>Budget</span>
                        <div className="price-filter-control">
                          <div className="price-filter-head">
                            <strong>
                              {effectiveMaxPrice < priceFilterBounds.max
                                ? `${formatPriceValue(effectiveMaxPrice)} and under`
                                : "Any price"}
                            </strong>
                            <span>
                              {formatPriceValue(priceFilterBounds.min)} to {formatPriceValue(priceFilterBounds.max)}
                            </span>
                          </div>
                          <input
                            aria-label="Maximum wine price"
                            className="price-filter-slider"
                            max={priceFilterBounds.max}
                            min={priceFilterBounds.min}
                            onChange={(event) => setMaxPriceFilter(Number(event.target.value))}
                            step={1}
                            type="range"
                            value={effectiveMaxPrice}
                          />
                          <label className="price-filter-toggle">
                            <input
                              checked={includePriceUnavailable}
                              onChange={(event) => setIncludePriceUnavailable(event.target.checked)}
                              type="checkbox"
                            />
                            <span>
                              Include wines without price
                              {priceFilterBounds.missingCount > 0
                                ? ` (${priceFilterBounds.missingCount})`
                                : ""}
                            </span>
                          </label>
                        </div>
                      </div>
                    ) : null}
                    {inferredRecommendationCount ? (
                      <div className="result-control-group">
                        <span>Taste data</span>
                        <div aria-label="Filter inferred taste profiles" className="sort-toggle" role="group">
                          <button
                            className={`sort-option${resultProfileFilter === "all" ? " is-active" : ""}`}
                            onClick={() => setResultProfileFilter("all")}
                            type="button"
                          >
                            All profiles
                          </button>
                          <button
                            className={`sort-option${resultProfileFilter === "exclude-inferred" ? " is-active" : ""}`}
                            onClick={() => setResultProfileFilter("exclude-inferred")}
                            type="button"
                          >
                            Hide inferred
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {analysis && inferredRecommendationCount ? (
                      <div className={`result-filter-notice${resultProfileFilter === "exclude-inferred" ? " is-filtered" : ""}`}>
                        <p className="result-filter-notice-title">
                          {resultProfileFilter === "exclude-inferred"
                            ? `${inferredRecommendationCount} inferred ${inferredRecommendationCount === 1 ? "profile" : "profiles"} hidden`
                            : `${inferredRecommendationCount} ${inferredRecommendationCount === 1 ? "wine uses" : "wines use"} estimated taste data`}
                        </p>
                        <p className="helper">
                          {resultProfileFilter === "exclude-inferred"
                            ? "These wines are excluded because Vivino did not return a reliable match."
                            : "When we cannot confirm a Vivino match, we infer the taste profile from the extracted wine details and show it with muted bars."}
                        </p>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
            {error ? <p className="error">{error}</p> : null}
            {!analysis ? <p className="helper">No analysis yet.</p> : null}
            {analysisProgress && analysisProgress.status !== "completed" ? (
              <AnalysisProgressPanel
                progress={analysisProgress}
              />
            ) : null}
            {analysis?.status === "failed" && analysis.errorMessage ? (
              <p className="error">{analysis.errorMessage}</p>
            ) : null}
            {analysis?.status === "canceled" && analysis.errorMessage ? (
              <p className="helper">{analysis.errorMessage}</p>
            ) : null}
            {priceFilterBounds && isPriceFilterActive ? (
              <div className="result-filter-notice is-filtered">
                <p className="result-filter-notice-title">
                  Budget filter active
                </p>
                <p className="helper">
                  {hiddenByPriceCount} wine{hiddenByPriceCount === 1 ? "" : "s"} hidden by the current budget
                  settings.
                </p>
              </div>
            ) : null}
            {hasStructuredResults ? (
              <div className="result-section-browser">
                <div className="result-section-browser-copy">
                  <p className="result-section-browser-title">Browse by menu section</p>
                  <p className="helper">
                    Jump between the source tabs and sections without losing the current ranking.
                  </p>
                </div>
                <div
                  aria-label="Filter results by source menu section"
                  className="result-section-browser-controls"
                  role="group"
                >
                  <button
                    className={`result-section-chip${selectedResultSectionId === allResultSectionsId ? " is-active" : ""}`}
                    onClick={() => setSelectedResultSectionId(allResultSectionsId)}
                    type="button"
                  >
                    <span>All sections</span>
                    <strong>{filteredRecommendations.length}</strong>
                  </button>
                  {resultSections.map((section) => (
                    <button
                      className={`result-section-chip${selectedResultSectionId === section.id ? " is-active" : ""}`}
                      key={section.id}
                      onClick={() => setSelectedResultSectionId(section.id)}
                      type="button"
                    >
                      <span>{section.label}</span>
                      <strong>{section.recommendations.length}</strong>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {analysis?.status === "processing" && analysis.candidates.length > 0 && filteredRecommendations.length === 0 ? (
              <p className="helper">Recommendations will appear here as each wine finishes processing.</p>
            ) : null}
            {analysis?.status === "canceled" && filteredRecommendations.length === 0 ? (
              <p className="helper">This run was stopped before any recommendations were saved.</p>
            ) : null}
            {analysis?.status === "completed" && filteredRecommendations.length === 0 ? (
              <p className="helper">No wines match the current result filters.</p>
            ) : null}
            {visibleResultSections.map((section) => (
              <section className="result-section" key={section.id}>
                {hasStructuredResults ? (
                  <div className="result-section-header">
                    <div>
                      <p className="result-section-kicker">Menu section</p>
                      <h3 className="result-section-title">{section.label}</h3>
                    </div>
                    <p className="result-section-count">
                      {section.recommendations.length} wine{section.recommendations.length === 1 ? "" : "s"}
                    </p>
                  </div>
                ) : null}
                <div className="result-section-cards">
                  {section.recommendations.map((recommendation) => (
                    <ResultCard
                      candidate={candidateById.get(recommendation.candidateId)}
                      key={recommendation.candidateId}
                      recommendation={recommendation}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </section>

        {/* ── Image break: bottle on shelf ── */}
        <section className="image-break image-break-shelf">
          <h2 className="image-break-text">
            Curated by data.<br />Chosen by taste.
          </h2>
        </section>
      </main>

    </div>
  );
}

function normalizeUrlInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed}`;
}

function getAnalysisProgress(analysis: AnalysisRun | null): AnalysisProgress | null {
  if (!analysis) {
    return null;
  }

  if (analysis.status === "uploaded" || analysis.status === "queued") {
    return {
      title: "Queued for processing",
      detail: "Waiting for the worker to start OCR and parse the wine list.",
      processed: 0,
      total: 0,
      fraction: null,
      status: analysis.status,
    };
  }

  const total = analysis.candidates.length;
  const processed = Math.min(analysis.recommendations.length, total);

  if (analysis.status === "processing") {
    if (total === 0) {
      return {
        title: "Running OCR",
        detail: "Extracting text and counting wine entries before per-wine matching begins.",
        processed: 0,
        total: 0,
        fraction: null,
        status: analysis.status,
      };
    }

    return {
      title: `Analyzing ${processed} of ${total} wines`,
      detail:
        processed === 0
          ? "OCR is done. The app is now matching each wine and fetching taste data."
          : "Progress updates automatically as each wine finishes processing.",
      processed,
      total,
      fraction: total > 0 ? processed / total : null,
      status: analysis.status,
    };
  }

  if (analysis.status === "failed") {
    return {
      title: "Analysis failed",
      detail: analysis.errorMessage ?? "The worker stopped before finishing the wine list.",
      processed,
      total,
      fraction: total > 0 ? processed / total : null,
      status: analysis.status,
    };
  }

  if (analysis.status === "canceled") {
    return {
      title:
        total > 0
          ? `Analysis stopped at ${processed} of ${total} wines`
          : "Analysis stopped",
      detail:
        total > 0
          ? "This run was stopped. Any recommendations shown below are partial results."
          : "This run was stopped before OCR and wine matching finished.",
      processed,
      total,
      fraction: total > 0 ? processed / total : null,
      status: analysis.status,
    };
  }

  return null;
}

function buildResultSections(
  analysis: AnalysisRun | null,
  recommendations: ResultRecommendation[],
  candidateById: Map<string, ResultCandidate>,
): ResultSection[] {
  if (!analysis || recommendations.length === 0) {
    return [];
  }

  const sectionOrder = new Map<string, number>();
  analysis.candidates.forEach((candidate, index) => {
    const id = getResultSectionId(candidate.menuTab, candidate.menuSection);
    if (!sectionOrder.has(id)) {
      sectionOrder.set(id, index);
    }
  });

  const sections = new Map<string, ResultSection>();

  recommendations.forEach((recommendation) => {
    const candidate = candidateById.get(recommendation.candidateId);
    const menuTab = candidate?.menuTab ?? null;
    const menuSection = candidate?.menuSection ?? null;
    const id = getResultSectionId(menuTab, menuSection);
    const existing = sections.get(id);

    if (existing) {
      existing.recommendations.push(recommendation);
      return;
    }

    sections.set(id, {
      id,
      label: formatMenuContext(menuTab, menuSection) || "Unlabeled results",
      menuTab,
      menuSection,
      recommendations: [recommendation],
    });
  });

  return [...sections.values()].sort((left, right) => {
    return (sectionOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (sectionOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER);
  });
}

function getResultSectionId(menuTab: string | null | undefined, menuSection: string | null | undefined): string {
  return `${menuTab ?? ""}:::${menuSection ?? ""}`;
}

function formatMenuContext(
  menuTab: string | null | undefined,
  menuSection: string | null | undefined,
): string {
  return [menuTab, menuSection].filter((value): value is string => Boolean(value)).join(" · ");
}

function AnalysisProgressPanel(props: {
  progress: AnalysisProgress;
  onCancel?: () => void;
  canCancel?: boolean;
  isCancelling?: boolean;
}) {
  const { canCancel = false, isCancelling = false, onCancel, progress } = props;
  const isIndeterminate =
    progress.fraction === null && progress.status !== "failed" && progress.status !== "canceled";
  const fillStyle =
    progress.fraction === null
      ? undefined
      : ({
          width: `${Math.max(progress.fraction * 100, progress.processed > 0 ? 6 : 0)}%`,
        } as CSSProperties);

  return (
    <section
      className={`analysis-progress${isIndeterminate ? " is-indeterminate" : ""}${
        progress.status === "failed" ? " is-failed" : ""
      }${progress.status === "canceled" ? " is-canceled" : ""}`}
    >
      <div className="analysis-progress-head">
        <div>
          <p className="analysis-progress-title">{progress.title}</p>
          <p className="analysis-progress-detail">{progress.detail}</p>
        </div>
        <div className="analysis-progress-count">
          {progress.total > 0 ? (
            <>
              <strong>{progress.processed}</strong>
              <span>/ {progress.total}</span>
            </>
          ) : progress.status === "canceled" ? (
            <strong>Stopped</strong>
          ) : progress.status === "failed" ? (
            <strong>Failed</strong>
          ) : (
            <strong>OCR</strong>
          )}
        </div>
      </div>
      <div
        aria-hidden="true"
        className={`analysis-progress-bar${progress.status === "failed" ? " is-failed" : ""}${
          progress.status === "canceled" ? " is-canceled" : ""
        }`}
      >
        <span className="analysis-progress-fill" style={fillStyle} />
      </div>
      {canCancel ? (
        <div className="analysis-progress-actions">
          <button
            className="action action-quiet"
            disabled={isCancelling}
            onClick={onCancel}
            type="button"
          >
            {isCancelling ? "Stopping…" : "Stop Analysis"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function ResultCard(props: {
  recommendation: ResultRecommendation;
  candidate: ResultCandidate | undefined;
}) {
  const { candidate, recommendation } = props;
  const [showTastingNotes, setShowTastingNotes] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const stack = containerRef.current?.closest<HTMLElement>(".stack");
    if (!stack) return;
    if (showTastingNotes && dropdownRef.current) {
      const height = dropdownRef.current.getBoundingClientRect().height;
      stack.style.setProperty("--notes-dropdown-height", `${height}px`);
    } else {
      stack.style.removeProperty("--notes-dropdown-height");
    }
  }, [showTastingNotes]);
  const isInferred = isInferredRecommendation(recommendation);
  const menuTitle = candidate?.rawText ?? recommendation.profile?.displayName ?? "Unmatched wine";
  const menuContext = formatMenuContext(candidate?.menuTab, candidate?.menuSection);
  const matchedTitle =
    recommendation.profile?.displayName && recommendation.profile.displayName !== menuTitle
      ? recommendation.profile.displayName
      : null;
  const imageUrl = recommendation.profile?.imageUrl ?? null;
  const imageLabel = recommendation.profile?.displayName ?? menuTitle;
  const detailSummary = isInferred
    ? `Estimated from menu data${
        recommendation.profile?.taste.confidence != null
          ? ` · profile confidence ${Math.round(recommendation.profile.taste.confidence * 100)}%`
          : ""
      }`
    : `${recommendation.profile?.provenanceLabel ?? "Unavailable"} · match ${Math.round(recommendation.matchConfidence * 100)}%`;
  const rating = recommendation.profile?.rating ?? null;
  const ratingCount = recommendation.profile?.ratingCount ?? null;
  const ratingSource = recommendation.profile?.ratingSource ?? null;
  const tasteReviewCount = recommendation.profile?.tasteReviewCount ?? null;
  const tastingNoteGroups = recommendation.profile?.tastingNoteGroups ?? [];
  const tastingNotesText = recommendation.profile?.tastingNotes?.trim() ?? "";
  const hasTastingNoteContent =
    tastingNoteGroups.length > 0 || tastingNotesText.length > 0;
  const showRating =
    rating !== null &&
    Number.isFinite(rating) &&
    ratingCount !== null &&
    Number.isFinite(ratingCount) &&
    ratingCount > 0;
  const showTasteReviewCount =
    tasteReviewCount !== null &&
    Number.isFinite(tasteReviewCount) &&
    tasteReviewCount > 0;
  const showNoTastingNotesIndicator = Boolean(
    recommendation.profile && !isInferred && !hasTastingNoteContent,
  );
  const restaurantPrice = parseCandidatePrice(candidate?.price);
  const retailPrice = recommendation.profile?.retailPrice ?? null;
  const priceBenchmark =
    restaurantPrice !== null && retailPrice !== null
      ? computePriceBenchmark(restaurantPrice, retailPrice)
      : null;

  return (
    <article className={`result-card${isInferred ? " is-inferred" : ""}${imageUrl ? " has-image" : ""}${showTastingNotes ? " is-notes-open" : ""}`} ref={containerRef}>
      {imageUrl ? (
        <div className="result-card-media">
          <img
            alt={`${imageLabel} bottle`}
            className="result-card-image"
            decoding="async"
            loading="lazy"
            referrerPolicy="no-referrer"
            src={imageUrl}
          />
        </div>
      ) : null}
      <div className="result-card-content">
        <div className="result-head">
          <div className="result-copy">
            <div className="wine-name-block">
              {menuContext ? <p className="menu-context">{menuContext}</p> : null}
              <h3 className="wine-title">{menuTitle}</h3>
            </div>
            {matchedTitle ? <p className="wine-subtitle">Matched to {matchedTitle}</p> : null}
            {isInferred ? (
              <p className="wine-uncertainty">
                No reliable Vivino match was found, so this taste profile is inferred from the
                extracted wine details.
              </p>
            ) : null}
            {showRating ? (
              <VivinoRatingBlock
                rating={rating}
                ratingCount={ratingCount}
                ratingSource={ratingSource}
              />
            ) : null}
          </div>
          <div className="result-summary">
            <p className={`price-tag${candidate?.price ? "" : " is-missing"}`}>
              {candidate?.price ?? "Price unavailable"}
            </p>
            <div className="score-badge">
              <span>Fit</span>
              <strong>{recommendation.fitScore}</strong>
            </div>
          </div>
        </div>
      </div>
      <div className={`taste-profile-block taste-profile-block-compact${isInferred ? " is-inferred" : ""}`}>
        <div className="taste-profile-heading">
          <div className="taste-profile-copy">
            <p className="taste-profile-title">What does this wine taste like?</p>
          </div>
          {isInferred ? <p className="taste-profile-note">Estimated profile</p> : null}
        </div>
        <div className="taste-scale-stack">
          {tasteDimensionOrder.map((dimension) => (
            <TasteScale
              dimension={dimension}
              key={dimension}
              tone={isInferred ? "uncertain" : "default"}
              value={recommendation.profile?.taste[dimension] ?? null}
            />
          ))}
        </div>
        {showTasteReviewCount ? (
          <p className="taste-profile-footnote">
            {formatTasteReviewCountLabel(tasteReviewCount)}
          </p>
        ) : null}
      </div>
      <div className="tasting-notes-collapsible">
        <button
          className="tasting-notes-toggle"
          onClick={() => setShowTastingNotes((v) => !v)}
          type="button"
        >
          <span>Tasting notes &amp; details</span>
          <span className={`tasting-notes-toggle-icon${showTastingNotes ? " is-open" : ""}`}>▾</span>
        </button>
        {showTastingNotes ? (
          <div className="tasting-notes-dropdown" ref={dropdownRef}>
            {hasTastingNoteContent || showNoTastingNotesIndicator ? (
              <div className="detail-tasting-notes-section">
                <p className="detail-section-label">Tasting notes</p>
                {showNoTastingNotesIndicator ? (
                  <p className="tasting-notes-empty">No tasting notes reported.</p>
                ) : tastingNoteGroups.length > 0 ? (
                  <TastingNoteGroupSection groups={tastingNoteGroups} />
                ) : tastingNotesText ? (
                  <p className="tasting-notes-fallback">
                    {tastingNotesText}
                  </p>
                ) : null}
              </div>
            ) : null}
            {candidate?.price || priceBenchmark ? (
              <div className={`detail-price-section${hasTastingNoteContent || showNoTastingNotesIndicator ? " has-separator" : ""}`}>
                <p className="detail-section-label">Price</p>
                <p className="detail-price-restaurant">
                  {candidate?.price ?? "Not listed"} on the menu
                </p>
                {priceBenchmark ? (
                  <p className={`detail-price-benchmark is-${priceBenchmark.tier}`}>
                    ~{formatPriceValue(priceBenchmark.retailPrice)} avg retail &middot; {priceBenchmark.multiplier.toFixed(1)}× markup
                  </p>
                ) : null}
              </div>
            ) : null}
            {!candidate?.price && !priceBenchmark && !hasTastingNoteContent && !showNoTastingNotesIndicator ? (
              <p className="tasting-notes-empty">No additional details available.</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function TastingNoteGroupSection(props: {
  groups: ResultTastingNoteGroup[];
}) {
  return (
    <section aria-label="Top tasting note families" className="tasting-note-section">
      <div className="tasting-note-groups">
        {props.groups.map((group, index) => (
          <TastingNoteGroupCard
            group={group}
            isPrimary={index === 0}
            key={`${group.key}-${index}`}
          />
        ))}
      </div>
    </section>
  );
}

function TastingNoteGroupCard(props: {
  group: ResultTastingNoteGroup;
  isPrimary: boolean;
}) {
  const visual = getTastingNoteVisual(props.group.key);
  const cueNotes = prioritizeCenterCueImage(
    props.group.keywords.slice(0, 3).map((keyword, index) => ({
      keyword,
      imageUrl: props.group.keywordImageUrls?.[index] ?? null,
    })),
  );
  const hasCueImages = cueNotes.some((cue) => Boolean(cue.imageUrl));
  const cardStyle = {
    "--note-accent": visual.accent,
    "--note-accent-soft": visual.accentSoft,
    "--note-art-foreground": "white",
    "--note-family-color": visual.accent,
    "--note-surface": visual.surface,
  } as CSSProperties;

  return (
    <article
      className={`tasting-note-card${props.isPrimary ? " is-primary" : ""}`}
      style={cardStyle}
    >
      <div className="tasting-note-card-body">
        <p className="tasting-note-card-family">{props.group.label}</p>
        <p className="tasting-note-card-keywords">
          {cueNotes.map((cue) => cue.keyword).join(", ")}
        </p>
      </div>
      <div className="tasting-note-card-art">
        <div
          className={`tasting-note-card-cue-cluster${hasCueImages ? "" : " is-fallback"}`}
        >
          {cueNotes.map((cue, index) => (
            <div
              className={`tasting-note-card-cue-frame cue-index-${index + 1}`}
              key={`${cue.keyword}-${index}`}
            >
              {cue.imageUrl ? (
                <img
                  alt=""
                  aria-hidden="true"
                  className="tasting-note-card-cue-image"
                  src={cue.imageUrl}
                />
              ) : (
                <span aria-hidden="true" className="tasting-note-card-icon">
                  <TastingNoteGroupIcon name={visual.icon} />
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

function prioritizeCenterCueImage(
  cueNotes: Array<{ keyword: string; imageUrl: string | null }>,
): Array<{ keyword: string; imageUrl: string | null }> {
  if (cueNotes.length < 3 || cueNotes[1]?.imageUrl) {
    return cueNotes;
  }

  const replacementIndex = cueNotes.findIndex((cue) => Boolean(cue.imageUrl));
  if (replacementIndex === -1) {
    return cueNotes;
  }

  const reordered = [...cueNotes];
  const centerCue = reordered[1]!;
  reordered[1] = reordered[replacementIndex]!;
  reordered[replacementIndex] = centerCue;
  return reordered;
}

function TasteScale(props: {
  dimension: TasteDimension;
  value: number | null;
  onChange?: (value: number) => void;
  tone?: TasteScaleTone;
}) {
  const copy = tasteScaleCopy[props.dimension];
  const markerStyle =
    props.value === null
      ? undefined
      : ({
          "--taste-indicator-ratio": getTasteIndicatorRatio(props.value),
        } as CSSProperties);

  return (
    <div
      className={`taste-scale${props.onChange ? " is-interactive" : ""}${props.value === null ? " is-empty" : ""}${
        props.tone === "uncertain" ? " is-uncertain" : ""
      }`}
    >
      <div className="taste-scale-row">
        <span className="taste-scale-endpoint">{copy.low}</span>
        <div className="taste-scale-control">
          <div className="taste-scale-track" style={markerStyle}>
            {props.onChange ? (
              <input
                aria-label={copy.label}
                aria-valuemax={5}
                aria-valuemin={1}
                aria-valuenow={props.value ?? 3}
                aria-valuetext={`${copy.low} to ${copy.high}, ${props.value ?? 3} out of 5`}
                className="taste-scale-input"
                max={5}
                min={1}
                onChange={(event) => props.onChange?.(Number(event.target.value))}
                step={1}
                type="range"
                value={props.value ?? 3}
              />
            ) : props.value !== null ? (
              <div className="taste-scale-marker" />
            ) : null}
          </div>
          <span className="sr-only">
            {copy.label}: {props.value ?? "Unavailable"}
          </span>
        </div>
        <span className="taste-scale-endpoint taste-scale-endpoint-right">{copy.high}</span>
      </div>
    </div>
  );
}

function getTasteIndicatorRatio(value: number): number {
  return (Math.max(1, Math.min(5, value)) - 1) / 4;
}

function isInferredRecommendation(recommendation: ResultRecommendation): boolean {
  return recommendation.profile?.taste.sourceMode === "inferred";
}

function filterRecommendationsByProfileSource(
  recommendations: ResultRecommendation[],
  filter: ResultProfileFilter,
): ResultRecommendation[] {
  if (filter === "all") {
    return recommendations;
  }

  return recommendations.filter((recommendation) => !isInferredRecommendation(recommendation));
}

function filterRecommendationsByPrice(
  recommendations: ResultRecommendation[],
  candidateById: Map<string, ResultCandidate>,
  maxPrice: number | null,
  includeUnavailable: boolean,
): ResultRecommendation[] {
  if (maxPrice == null) {
    return recommendations.filter((recommendation) => {
      const parsedPrice = parseCandidatePrice(candidateById.get(recommendation.candidateId)?.price);
      return includeUnavailable || parsedPrice !== null;
    });
  }

  return recommendations.filter((recommendation) => {
    const parsedPrice = parseCandidatePrice(candidateById.get(recommendation.candidateId)?.price);

    if (parsedPrice === null) {
      return includeUnavailable;
    }

    return parsedPrice <= maxPrice;
  });
}

function getPriceFilterBounds(candidates: ResultCandidate[]): PriceFilterBounds | null {
  const parsedPrices = candidates
    .map((candidate) => parseCandidatePrice(candidate.price))
    .filter((price): price is number => price !== null);

  if (parsedPrices.length === 0) {
    return null;
  }

  return {
    min: Math.max(0, Math.floor(Math.min(...parsedPrices))),
    max: Math.ceil(Math.max(...parsedPrices)),
    pricedCount: parsedPrices.length,
    missingCount: candidates.length - parsedPrices.length,
  };
}

function parseCandidatePrice(price: string | null | undefined): number | null {
  if (!price) {
    return null;
  }

  const match = price.match(/\d+(?:\.\d{1,2})?/);
  if (!match) {
    return null;
  }

  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatPriceValue(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

type PriceBenchmarkTier = "fair" | "average" | "steep";

function computePriceBenchmark(
  restaurantPrice: number,
  retailPrice: number,
): { retailPrice: number; multiplier: number; tier: PriceBenchmarkTier } | null {
  if (retailPrice <= 0 || restaurantPrice <= 0) return null;
  const multiplier = restaurantPrice / retailPrice;
  const tier: PriceBenchmarkTier =
    multiplier <= 2.5 ? "fair" : multiplier <= 3.5 ? "average" : "steep";
  return { retailPrice, multiplier, tier };
}

function formatTasteReviewCountLabel(count: number): string {
  const normalized = Math.max(0, Math.round(count));
  return `Based on ${ratingCountFormatter.format(normalized)} user ${
    normalized === 1 ? "review" : "reviews"
  }`;
}

function getTastingNoteVisual(groupKey: string): TastingNoteVisual {
  const normalized = groupKey.toLowerCase();
  const exactMatch = tastingNoteVisuals[normalized];
  if (exactMatch) return exactMatch;

  if (normalized.includes("fruit")) {
    return tastingNoteVisuals["tree-fruit"] ?? defaultTastingNoteVisual;
  }

  if (normalized.includes("yeast") || normalized.includes("microbio")) {
    return tastingNoteVisuals.yeasty ?? defaultTastingNoteVisual;
  }

  if (normalized.includes("flower")) {
    return tastingNoteVisuals.floral ?? defaultTastingNoteVisual;
  }

  if (
    normalized.includes("earth") ||
    normalized.includes("herb") ||
    normalized.includes("vegetal") ||
    normalized.includes("green")
  ) {
    return tastingNoteVisuals.earth ?? defaultTastingNoteVisual;
  }

  if (normalized.includes("oak") || normalized.includes("spice")) {
    return tastingNoteVisuals.spices ?? defaultTastingNoteVisual;
  }

  return defaultTastingNoteVisual;
}

function TastingNoteGroupIcon(props: { name: TastingNoteIconName }) {
  const sharedProps = {
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.8,
    viewBox: "0 0 48 48",
  };

  switch (props.name) {
    case "berries":
      return (
        <svg {...sharedProps}>
          <path d="M24 16c0-5 4-9 10-9" />
          <path d="M23 16c-1-4-5-7-10-7" />
          <circle cx="18" cy="27" r="6" />
          <circle cx="29" cy="25" r="7" />
          <circle cx="31" cy="34" r="5" />
        </svg>
      );
    case "loaf":
      return (
        <svg {...sharedProps}>
          <path d="M11 33a12 12 0 0 1 12-12h3a11 11 0 0 1 11 11v5H11Z" />
          <path d="M20 22v7" />
          <path d="M27 21v8" />
          <path d="M34 23v6" />
        </svg>
      );
    case "citrus":
      return (
        <svg {...sharedProps}>
          <circle cx="24" cy="24" r="12" />
          <path d="M24 12v24" />
          <path d="M12 24h24" />
          <path d="M16 16l16 16" />
          <path d="M32 16 16 32" />
        </svg>
      );
    case "flower":
      return (
        <svg {...sharedProps}>
          <circle cx="24" cy="24" r="4" />
          <circle cx="24" cy="15" r="5" />
          <circle cx="33" cy="24" r="5" />
          <circle cx="24" cy="33" r="5" />
          <circle cx="15" cy="24" r="5" />
        </svg>
      );
    case "leaf":
      return (
        <svg {...sharedProps}>
          <path d="M34 14c-12 1-20 9-20 20 11 0 19-8 20-20Z" />
          <path d="M18 30c5-4 9-8 13-13" />
        </svg>
      );
    case "barrel":
      return (
        <svg {...sharedProps}>
          <path d="M17 12h14" />
          <path d="M15 18c2-4 2-8 2-8h14s0 4 2 8c2 4 2 8 2 8s0 4-2 8c-2 4-2 8-2 8H17s0-4-2-8c-2-4-2-8-2-8s0-4 2-8Z" />
          <path d="M14 24h20" />
          <path d="M16 16h16" />
          <path d="M16 32h16" />
        </svg>
      );
    default:
      return (
        <svg {...sharedProps}>
          <path d="m24 11 3.5 8.5L36 23l-8.5 3.5L24 35l-3.5-8.5L12 23l8.5-3.5Z" />
        </svg>
      );
  }
}

function VivinoRatingBlock(props: {
  rating: number;
  ratingCount: number;
  ratingSource: WineRatingSource | null;
}) {
  const { rating, ratingCount, ratingSource } = props;
  const formattedRating = ratingFormatter.format(Math.max(0, Math.min(5, rating)));
  const countLabel = `${ratingCountFormatter.format(ratingCount)} ${
    ratingCount === 1 ? "rating" : "ratings"
  }`;

  return (
    <div
      aria-label={`Vivino rating ${formattedRating} out of 5 from ${countLabel}${
        ratingSource === "wine" ? ", based on all vintages" : ""
      }`}
      className="vivino-rating"
      title={
        ratingSource === "wine"
          ? "Vivino aggregate based on all vintages for this wine"
          : "Vivino aggregate for the matched vintage"
      }
    >
      <span className="vivino-rating-value">{formattedRating}</span>
      <div className="vivino-rating-meta">
        <StarRating rating={rating} />
        <span className="vivino-rating-count">{countLabel}</span>
      </div>
    </div>
  );
}

function StarRating(props: { rating: number }) {
  const fillWidth = `${Math.max(0, Math.min(5, props.rating)) * 20}%`;

  return (
    <span
      aria-hidden="true"
      className="star-rating"
      style={{ "--star-fill-width": fillWidth } as CSSProperties}
    >
      <span className="star-rating-base">★★★★★</span>
      <span className="star-rating-fill">★★★★★</span>
    </span>
  );
}

function formatStatusLabel(status: "matched" | "low-confidence" | "unmatched"): string {
  if (status === "low-confidence") {
    return "Low confidence";
  }

  return status[0]!.toUpperCase() + status.slice(1);
}
