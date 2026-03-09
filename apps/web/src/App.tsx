import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

import type {
  AnalysisRun,
  CreateAnalysisResponse,
  ProviderHealth,
  ProviderSettings,
  UserTastePreference,
} from "@wine-rec/contracts";

const apiBaseUrl =
  import.meta.env.VITE_API_BASE_URL ??
  `${window.location.protocol}//${window.location.hostname}:3001`;

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

type AnalysisState = {
  analysisId: string;
  status: string;
};

type ResultSortOrder = "recommended" | "discovered";
type ResultRecommendation = AnalysisRun["recommendations"][number];
type ResultCandidate = AnalysisRun["candidates"][number];
type ResultSection = {
  id: string;
  label: string;
  menuTab: string | null;
  menuSection: string | null;
  recommendations: ResultRecommendation[];
};

const defaultProviderSettings: ProviderSettings = {
  apifyVivinoEnabled: true,
};

type TasteDimension = "body" | "tannin" | "sweetness" | "acidity";

const tasteDimensionOrder: TasteDimension[] = ["body", "tannin", "sweetness", "acidity"];
const allResultSectionsId = "__all_sections__";

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
    throw new Error(`Request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function sortRecommendations(
  analysis: AnalysisRun,
  sortOrder: ResultSortOrder,
): AnalysisRun["recommendations"] {
  if (sortOrder === "recommended") {
    return analysis.recommendations;
  }

  const discoveredOrder = new Map(
    analysis.candidates.map((candidate, index) => [candidate.id, index]),
  );
  const rankedOrder = new Map(
    analysis.recommendations.map((recommendation, index) => [recommendation.candidateId, index]),
  );

  return [...analysis.recommendations].sort((left, right) => {
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
  const [preferences, setPreferences] = useState<UserTastePreference>(defaultPreferences);
  const [loadedPreferences, setLoadedPreferences] = useState<UserTastePreference>(defaultPreferences);
  const [providerSettings, setProviderSettings] = useState<ProviderSettings>(defaultProviderSettings);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [analysisState, setAnalysisState] = useState<AnalysisState | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisRun | null>(null);
  const [resultSortOrder, setResultSortOrder] = useState<ResultSortOrder>("recommended");
  const [selectedResultSectionId, setSelectedResultSectionId] = useState(allResultSectionsId);
  const [providerHealth, setProviderHealth] = useState<ProviderHealth[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savingProviderSettings, setSavingProviderSettings] = useState(false);
  const sortedRecommendations = analysis ? sortRecommendations(analysis, resultSortOrder) : [];
  const candidateById = analysis
    ? new Map(analysis.candidates.map((candidate) => [candidate.id, candidate]))
    : new Map<string, ResultCandidate>();
  const resultSections = buildResultSections(analysis, sortedRecommendations, candidateById);
  const hasStructuredResults = resultSections.some((section) => section.menuTab || section.menuSection);
  const visibleResultSections =
    selectedResultSectionId === allResultSectionsId
      ? resultSections
      : resultSections.filter((section) => section.id === selectedResultSectionId);

  function updatePreference(dimension: TasteDimension, value: number) {
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

  async function refreshProviderHealth() {
    const nextHealth = await getJson<ProviderHealth[]>("/api/health/providers");
    setProviderHealth(nextHealth);
  }

  useEffect(() => {
    void Promise.all([
      getJson<{ preferences: UserTastePreference }>("/api/preferences").then((response) =>
        {
          setPreferences(response.preferences);
          setLoadedPreferences(response.preferences);
        },
      ),
      getJson<{ settings: ProviderSettings }>("/api/settings/providers").then((response) => {
        setProviderSettings(response.settings);
      }),
      getJson<ProviderHealth[]>("/api/health/providers").then(
        setProviderHealth,
      ),
    ]).catch((cause) => {
      setError(cause instanceof Error ? cause.message : "Failed to load API state");
    });
  }, []);

  useEffect(() => {
    if (!analysisState || analysisState.status === "completed" || analysisState.status === "failed") {
      return;
    }

    const handle = window.setInterval(() => {
      void getJson<AnalysisRun>(`/api/analyses/${analysisState.analysisId}`)
        .then((response) => {
          setAnalysis(response);
          setAnalysisState({ analysisId: response.id, status: response.status });
        })
        .catch((cause) => {
          setError(cause instanceof Error ? cause.message : "Failed to refresh analysis");
        });
    }, 2000);

    return () => window.clearInterval(handle);
  }, [analysisState]);

  useEffect(() => {
    if (
      selectedResultSectionId !== allResultSectionsId &&
      !resultSections.some((section) => section.id === selectedResultSectionId)
    ) {
      setSelectedResultSectionId(allResultSectionsId);
    }
  }, [resultSections, selectedResultSectionId]);

  async function savePreferences(next: UserTastePreference) {
    setPreferences(next);
    await getJson<{ preferences: UserTastePreference }>("/api/preferences", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(next),
    });
    setLoadedPreferences(next);
  }

  async function saveProviderSettings(next: ProviderSettings) {
    setProviderSettings(next);
    setSavingProviderSettings(true);
    setError(null);

    try {
      const response = await getJson<{ settings: ProviderSettings }>("/api/settings/providers", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(next),
      });

      setProviderSettings(response.settings);
      await refreshProviderHealth();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to update provider settings");
    } finally {
      setSavingProviderSettings(false);
    }
  }

  async function handleUpload() {
    if (!selectedFile) {
      setError("Choose an image or PDF first.");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      await prepareAnalysis();

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

  async function handleUrlSubmit() {
    const normalizedUrl = normalizeUrlInput(sourceUrl);
    if (!normalizedUrl) {
      setError("Paste a menu or wine-list URL first.");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      await prepareAnalysis();

      const created = await getJson<CreateAnalysisResponse>("/api/urls", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: normalizedUrl }),
      });

      setSourceUrl(normalizedUrl);
      await launchAnalysis(created);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "URL analysis failed");
    } finally {
      setBusy(false);
    }
  }

  async function prepareAnalysis() {
    if (!preferencesEqual(preferences, loadedPreferences)) {
      await savePreferences(preferences);
    }
  }

  async function launchAnalysis(next: CreateAnalysisResponse) {
    await getJson(`/api/analyses/${next.analysisId}/process`, { method: "POST" });
    const nextAnalysis = await getJson<AnalysisRun>(`/api/analyses/${next.analysisId}`);
    setAnalysisState({ analysisId: next.analysisId, status: nextAnalysis.status });
    setAnalysis(nextAnalysis);
  }

  return (
    <div className="page-shell">
      <div className="backdrop" />
      <main className="page">
        <section className="hero-card">
          <p className="eyebrow">Local Debug Surface</p>
          <h1>Wine Rec</h1>
          <p className="lede">
            Upload a wine list image or PDF, or paste a restaurant / store URL, then rank the
            wines against a crisp, dry preference profile.
          </p>
          <div className="hero-grid">
            <div className="panel">
              <h2>Preferred Profile</h2>
              <p className="section-copy">
                Move each scale toward the wine style you want the recommendations to match.
              </p>
              <div className="taste-profile-block">
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
              </div>
            </div>
            <div className="panel">
              <h2>Ingest</h2>
              <div className="ingest-stack">
                <label className="url-field">
                  <span>Paste a menu or collection URL</span>
                  <input
                    onChange={(event) => setSourceUrl(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void handleUrlSubmit();
                      }
                    }}
                    placeholder="https://example.com/wine-list"
                    type="url"
                    value={sourceUrl}
                  />
                </label>
                <button
                  className="action action-secondary"
                  disabled={busy}
                  onClick={handleUrlSubmit}
                  type="button"
                >
                  {busy ? "Processing…" : "Analyze URL"}
                </button>

                <div className="ingest-divider">
                  <span>or</span>
                </div>

                <label className="upload-zone">
                  <span>Drop in a screenshot, photo, or PDF</span>
                  <input
                    accept="image/*,application/pdf"
                    onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
                    type="file"
                  />
                </label>
                <button className="action" disabled={busy} onClick={handleUpload} type="button">
                  {busy ? "Processing…" : "Analyze Upload"}
                </button>
              </div>
              {selectedFile ? <p className="helper">Selected: {selectedFile.name}</p> : null}
              {analysisState ? (
                <p className="helper">
                  Analysis {analysisState.analysisId.slice(0, 8)} · {analysisState.status}
                </p>
              ) : null}
            </div>
          </div>
        </section>

        <section className="stack">
          <div className="panel">
            <h2>Provider Health</h2>
            <div className="provider-controls">
              <div className="provider-toggle-card">
                <div>
                  <p className="provider-toggle-label">Apify Vivino</p>
                  <p className="provider-toggle-copy">
                    Toggle paid Vivino-backed lookups on only when you want a real scrape run.
                  </p>
                </div>
                <label className="provider-toggle">
                  <input
                    checked={providerSettings.apifyVivinoEnabled}
                    disabled={savingProviderSettings || busy}
                    onChange={(event) => {
                      void saveProviderSettings({
                        ...providerSettings,
                        apifyVivinoEnabled: event.target.checked,
                      });
                    }}
                    type="checkbox"
                  />
                  <span className="provider-toggle-ui" />
                  <span className="provider-toggle-state">
                    {providerSettings.apifyVivinoEnabled ? "On" : "Off"}
                  </span>
                </label>
              </div>
              <p className="helper">
                {savingProviderSettings
                  ? "Saving provider controls…"
                  : "Apify uses your limited credits. Keep it off for OCR/parser iteration and switch it on for real provider runs."}
              </p>
            </div>
            <div className="provider-list">
              {providerHealth.map((provider) => (
                <article className="provider-chip" key={provider.name}>
                  <strong>{provider.name}</strong>
                  <span>{provider.enabled ? "enabled" : "disabled"}</span>
                  <p>{provider.detail}</p>
                </article>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="result-header">
              <h2>Results</h2>
              {analysis?.recommendations.length ? (
                <div className="result-controls">
                  <span>Sort by</span>
                  <div aria-label="Sort results" className="sort-toggle" role="group">
                    <button
                      className={`sort-option${resultSortOrder === "recommended" ? " is-active" : ""}`}
                      onClick={() => setResultSortOrder("recommended")}
                      type="button"
                    >
                      Most recommended
                    </button>
                    <button
                      className={`sort-option${resultSortOrder === "discovered" ? " is-active" : ""}`}
                      onClick={() => setResultSortOrder("discovered")}
                      type="button"
                    >
                      Image order
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
            {error ? <p className="error">{error}</p> : null}
            {!analysis ? <p className="helper">No analysis yet.</p> : null}
            {analysis?.errorMessage ? <p className="error">{analysis.errorMessage}</p> : null}
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
                    <strong>{sortedRecommendations.length}</strong>
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
                {section.recommendations.map((recommendation) => (
                  <ResultCard
                    candidate={candidateById.get(recommendation.candidateId)}
                    key={recommendation.candidateId}
                    recommendation={recommendation}
                  />
                ))}
              </section>
            ))}
          </div>
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

function ResultCard(props: {
  recommendation: ResultRecommendation;
  candidate: ResultCandidate | undefined;
}) {
  const { candidate, recommendation } = props;
  const menuTitle = candidate?.rawText ?? recommendation.profile?.displayName ?? "Unmatched wine";
  const menuContext = formatMenuContext(candidate?.menuTab, candidate?.menuSection);
  const matchedTitle =
    recommendation.profile?.displayName && recommendation.profile.displayName !== menuTitle
      ? recommendation.profile.displayName
      : null;

  return (
    <article className="result-card">
      <div className="result-head">
        <div className="result-copy">
          {menuContext ? <p className="menu-context">{menuContext}</p> : null}
          <h3 className="wine-title">{menuTitle}</h3>
          {matchedTitle ? <p className="wine-subtitle">Matched to {matchedTitle}</p> : null}
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
      <div className="result-footer">
        <span>
          {recommendation.profile?.provenanceLabel ?? "Unavailable"} · match{" "}
          {Math.round(recommendation.matchConfidence * 100)}%
        </span>
        <span className="status-tag">{formatStatusLabel(recommendation.status)}</span>
      </div>
      <div className="taste-profile-block taste-profile-block-compact">
        <p className="taste-profile-title">What does this wine taste like?</p>
        <div className="taste-scale-stack">
          {tasteDimensionOrder.map((dimension) => (
            <TasteScale dimension={dimension} key={dimension} value={recommendation.profile?.taste[dimension] ?? null} />
          ))}
        </div>
      </div>
      {recommendation.profile?.tastingNotes ? (
        <p className="tasting-notes">
          <span className="tasting-notes-label">Tasting notes: </span>
          {recommendation.profile.tastingNotes}
        </p>
      ) : null}
    </article>
  );
}

function TasteScale(props: {
  dimension: TasteDimension;
  value: number | null;
  onChange?: (value: number) => void;
}) {
  const copy = tasteScaleCopy[props.dimension];
  const markerStyle =
    props.value === null
      ? undefined
      : ({
          "--taste-indicator-position": `${getTasteIndicatorPosition(props.value)}%`,
        } as CSSProperties);

  return (
    <div className={`taste-scale${props.onChange ? " is-interactive" : ""}${props.value === null ? " is-empty" : ""}`}>
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

function getTasteIndicatorPosition(value: number): number {
  return 7 + ((Math.max(1, Math.min(5, value)) - 1) / 4) * 86;
}

function formatStatusLabel(status: "matched" | "low-confidence" | "unmatched"): string {
  if (status === "low-confidence") {
    return "Low confidence";
  }

  return status[0]!.toUpperCase() + status.slice(1);
}
