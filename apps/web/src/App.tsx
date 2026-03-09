import { useEffect, useState } from "react";

import type { AnalysisRun, UserTastePreference } from "@wine-rec/contracts";

const apiBaseUrl =
  import.meta.env.VITE_API_BASE_URL ??
  `${window.location.protocol}//${window.location.hostname}:3001`;

const defaultPreferences: UserTastePreference = {
  body: 5,
  acidity: 9,
  tannin: 5,
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

type UploadState = {
  analysisId: string;
  status: string;
};

type ResultSortOrder = "recommended" | "discovered";

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
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadState, setUploadState] = useState<UploadState | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisRun | null>(null);
  const [resultSortOrder, setResultSortOrder] = useState<ResultSortOrder>("recommended");
  const [providerHealth, setProviderHealth] = useState<
    Array<{ name: string; enabled: boolean; detail: string }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sortedRecommendations = analysis ? sortRecommendations(analysis, resultSortOrder) : [];
  const candidateById = analysis
    ? new Map(analysis.candidates.map((candidate) => [candidate.id, candidate]))
    : new Map<string, AnalysisRun["candidates"][number]>();

  useEffect(() => {
    void Promise.all([
      getJson<{ preferences: UserTastePreference }>("/api/preferences").then((response) =>
        {
          setPreferences(response.preferences);
          setLoadedPreferences(response.preferences);
        },
      ),
      getJson<Array<{ name: string; enabled: boolean; detail: string }>>("/api/health/providers").then(
        setProviderHealth,
      ),
    ]).catch((cause) => {
      setError(cause instanceof Error ? cause.message : "Failed to load API state");
    });
  }, []);

  useEffect(() => {
    if (!uploadState || uploadState.status === "completed" || uploadState.status === "failed") {
      return;
    }

    const handle = window.setInterval(() => {
      void getJson<AnalysisRun>(`/api/analyses/${uploadState.analysisId}`)
        .then((response) => {
          setAnalysis(response);
          setUploadState({ analysisId: response.id, status: response.status });
        })
        .catch((cause) => {
          setError(cause instanceof Error ? cause.message : "Failed to refresh analysis");
        });
    }, 2000);

    return () => window.clearInterval(handle);
  }, [uploadState]);

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

  async function handleUpload() {
    if (!selectedFile) {
      setError("Choose an image or PDF first.");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      if (!preferencesEqual(preferences, loadedPreferences)) {
        await savePreferences(preferences);
      }

      const formData = new FormData();
      formData.set("file", selectedFile);

      const upload = await getJson<{ analysisId: string; status: string }>("/api/uploads", {
        method: "POST",
        body: formData,
      });

      await getJson(`/api/analyses/${upload.analysisId}/process`, { method: "POST" });
      const nextAnalysis = await getJson<AnalysisRun>(`/api/analyses/${upload.analysisId}`);
      setUploadState(upload);
      setAnalysis(nextAnalysis);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-shell">
      <div className="backdrop" />
      <main className="page">
        <section className="hero-card">
          <p className="eyebrow">Local Debug Surface</p>
          <h1>Wine Rec</h1>
          <p className="lede">
            Upload a restaurant wine list, store screenshot, or PDF, then rank the wines against
            a crisp, dry preference profile.
          </p>
          <div className="hero-grid">
            <div className="panel">
              <h2>Preference Vector</h2>
              <PreferenceSlider
                label="Acidity"
                value={preferences.acidity}
                onChange={(value) => setPreferences({ ...preferences, acidity: value })}
              />
              <PreferenceSlider
                label="Sweetness"
                value={preferences.sweetness}
                onChange={(value) => setPreferences({ ...preferences, sweetness: value })}
              />
              <PreferenceSlider
                label="Body"
                value={preferences.body}
                onChange={(value) => setPreferences({ ...preferences, body: value })}
              />
              <PreferenceSlider
                label="Tannin"
                value={preferences.tannin}
                onChange={(value) => setPreferences({ ...preferences, tannin: value })}
              />
            </div>
            <div className="panel">
              <h2>Upload</h2>
              <label className="upload-zone">
                <span>Drop in a screenshot, photo, or PDF</span>
                <input
                  accept="image/*,application/pdf"
                  onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
                  type="file"
                />
              </label>
              <button className="action" disabled={busy} onClick={handleUpload} type="button">
                {busy ? "Processing…" : "Analyze Wine List"}
              </button>
              {selectedFile ? <p className="helper">Selected: {selectedFile.name}</p> : null}
              {uploadState ? (
                <p className="helper">
                  Analysis {uploadState.analysisId.slice(0, 8)} · {uploadState.status}
                </p>
              ) : null}
            </div>
          </div>
        </section>

        <section className="stack">
          <div className="panel">
            <h2>Provider Health</h2>
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
            {sortedRecommendations.map((recommendation) => {
              const candidate = candidateById.get(recommendation.candidateId);
              const menuTitle = candidate?.rawText ?? recommendation.profile?.displayName ?? "Unmatched wine";
              const matchedTitle =
                recommendation.profile?.displayName &&
                recommendation.profile.displayName !== menuTitle
                  ? recommendation.profile.displayName
                  : null;

              return (
                <article className="result-card" key={recommendation.candidateId}>
                  <div className="result-head">
                    <div className="result-copy">
                      <h3 className="wine-title">{menuTitle}</h3>
                      {matchedTitle ? (
                        <p className="wine-subtitle">Matched to {matchedTitle}</p>
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
                  <div className="result-footer">
                    <span>
                      {recommendation.profile?.provenanceLabel ?? "Unavailable"} · match{" "}
                      {Math.round(recommendation.matchConfidence * 100)}%
                    </span>
                    <span className="status-tag">{formatStatusLabel(recommendation.status)}</span>
                  </div>
                  <div className="taste-grid">
                    <TasteMeter
                      label="Acidity"
                      value={recommendation.profile?.taste.acidity ?? null}
                    />
                    <TasteMeter
                      label="Sweetness"
                      value={recommendation.profile?.taste.sweetness ?? null}
                    />
                    <TasteMeter label="Body" value={recommendation.profile?.taste.body ?? null} />
                    <TasteMeter label="Tannin" value={recommendation.profile?.taste.tannin ?? null} />
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      </main>
    </div>
  );
}

function PreferenceSlider(props: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="slider-field">
      <span>
        {props.label} <strong>{props.value}</strong>
      </span>
      <input
        max={10}
        min={1}
        onChange={(event) => props.onChange(Number(event.target.value))}
        type="range"
        value={props.value}
      />
    </label>
  );
}

function TasteMeter(props: { label: string; value: number | null }) {
  const fillWidth = props.value ? `${Math.max(0, Math.min(100, (props.value / 10) * 100))}%` : "0%";

  return (
    <div className="taste-meter">
      <div className="taste-meter-head">
        <span>{props.label}</span>
        <strong>{props.value ?? "—"}</strong>
      </div>
      <div className={`taste-meter-track${props.value ? "" : " is-empty"}`}>
        <div className="taste-meter-fill" style={{ width: fillWidth }} />
      </div>
    </div>
  );
}

function formatStatusLabel(status: "matched" | "low-confidence" | "unmatched"): string {
  if (status === "low-confidence") {
    return "Low confidence";
  }

  return status[0]!.toUpperCase() + status.slice(1);
}
