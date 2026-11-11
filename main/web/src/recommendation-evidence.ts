import type { Recommendation, WineCandidate } from "@wine-rec/contracts";
import { hasComparableFit } from "@wine-rec/contracts";

export function recommendationEvidence(recommendation: Recommendation) {
  const taste = recommendation.profile?.taste;
  const inferred = taste?.sourceMode === "inferred";
  const dimensions = taste?.observedDimensions;
  const canShowFit = hasComparableFit(recommendation);
  return {
    canShowFit,
    fitLabel: inferred ? "Estimated fit" : "Taste fit",
    identityLabel: inferred ? "Estimated style; bottle identity unverified"
      : recommendation.status === "matched" ? "Bottle match"
      : recommendation.status === "low-confidence" ? "Possible bottle match; verify label and vintage"
      : "No reliable bottle match",
    tasteLabel: inferred ? (taste?.confidence ? "Estimated from menu details" : "Insufficient style information")
      : dimensions ? `${new Set(dimensions).size}/4 taste dimensions available`
      : "Taste-data completeness not recorded",
    isDimensionAvailable: (dimension: "body" | "acidity" | "tannin" | "sweetness") =>
      Boolean(taste && (inferred ? taste.confidence > 0 : dimensions?.includes(dimension))),
  };
}


const displayText = (value: string | null | undefined): string => value?.replace(/\s+/g, " ").trim() ?? "";
const identityKey = (value: string): string => value.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Join only structured menu identity, preserving raw text as a fallback. */
export function recommendationDisplay(candidate: WineCandidate | undefined, recommendation: Recommendation) {
  const producer = displayText(candidate?.producer);
  const label = displayText(candidate?.label);
  let title = producer || label;
  if (producer && label) {
    const left = producer.split(" ");
    const right = label.split(" ");
    let overlap = 0;
    for (let size = 1; size <= Math.min(left.length, right.length); size++) {
      if (identityKey(left.slice(-size).join(" ")) === identityKey(right.slice(0, size).join(" "))) overlap = size;
    }
    title = [...left, ...right.slice(overlap)].join(" ");
  }
  const profileTitle = displayText(recommendation.profile?.displayName);
  title ||= displayText(candidate?.rawText) || profileTitle || "Unmatched wine";
  const detailParts = [candidate?.varietal, candidate?.region, candidate?.vintage?.toString()]
    .map(displayText).filter(Boolean);
  const seen = new Set<string>();
  const menuDetails = detailParts.filter(part => {
    const key = identityKey(part);
    if (seen.has(key) || (` ${identityKey(title)} `).includes(` ${key} `)) return false;
    seen.add(key); return true;
  }).join(" · ");
  const inferred = recommendation.profile?.taste?.sourceMode === "inferred";
  return {
    title,
    menuDetails,
    matchedTitle: !inferred && profileTitle && identityKey(profileTitle) !== identityKey(title) ? profileTitle : null,
  };
}
