import { describe, expect, it } from "vitest";
import type { Recommendation, WineCandidate } from "@wine-rec/contracts";
import { compareRecommendationFit, tasteVectorSchema } from "@wine-rec/contracts";
import { recommendationEvidence, recommendationDisplay } from "./recommendation-evidence";
const rec = (changes: object): Recommendation => ({ status: "matched", matchConfidence: 0.9,
  profile: { taste: { sourceMode: "direct", confidence: 0.9, observedDimensions: ["body", "acidity", "tannin", "sweetness"], ...changes } },
} as Recommendation);
describe("recommendation evidence", () => {
  it("shows fit only for complete measured or explicitly estimated taste", () => {
    expect(recommendationEvidence(rec({})).canShowFit).toBe(true);
    expect(recommendationEvidence(rec({ observedDimensions: ["body"] })).canShowFit).toBe(false);
    expect(recommendationEvidence(rec({ observedDimensions: undefined })).canShowFit).toBe(false);
    expect(recommendationEvidence(rec({ confidence: 0 })).canShowFit).toBe(false);
    expect(recommendationEvidence(rec({ observedDimensions: ["body", "body", "body", "body"] })).canShowFit).toBe(false);
    expect(recommendationEvidence(rec({ sourceMode: "inferred", confidence: 0.45 })).fitLabel).toBe("Estimated fit");
  });
  it("does not call a low identity score a verified bottle match", () => {
    const value = recommendationEvidence({ ...rec({}), status: "low-confidence" });
    expect(value.canShowFit).toBe(false);
    expect(value.identityLabel).toContain("Possible");
  });
  it("does not sort hidden legacy or uncertain-identity fit scores above eligible fits", () => {
    const complete = { ...rec({}), candidateId: "complete", fitScore: 90 };
    const wrongBottle = { ...rec({}), candidateId: "uncertain", fitScore: 100, status: "low-confidence" as const };
    const legacy = { ...rec({ observedDimensions: undefined }), candidateId: "legacy", fitScore: 100 };
    expect([wrongBottle, legacy, complete].sort(compareRecommendationFit)[0]?.candidateId).toBe("complete");
    expect([wrongBottle, { ...complete, fitScore: 0 }].sort(compareRecommendationFit)[0]?.candidateId).toBe("complete");
  });
  it("rejects duplicate dimension claims while preserving legacy decoding", () => {
    const vector = { body: 3, acidity: 3, tannin: 3, sweetness: 3, sourceMode: "direct", confidence: 0.9 };
    expect(tasteVectorSchema.safeParse(vector).success).toBe(true);
    expect(tasteVectorSchema.safeParse({ ...vector, observedDimensions: ["body", "body", "body", "body"] }).success).toBe(false);
  });
});


describe("compact menu identity display", () => {
  const candidate = (changes: object) => ({producer:null,label:null,varietal:null,region:null,vintage:null,rawText:"Original menu listing",...changes} as unknown as WineCandidate);
  it("joins producer and label without repeating their overlap", () => {
    expect(recommendationDisplay(candidate({producer:"Domaine Martin",label:"Martin Petite Nature"}),rec({})).title).toBe("Domaine Martin Petite Nature");
  });
  it("normalizes punctuation and accents only for overlap comparison", () => {
    expect(recommendationDisplay(candidate({producer:"Domaine Stéphane",label:"Stephane ‘Tradition’"}),rec({})).title).toBe("Domaine Stéphane ‘Tradition’");
  });
  it("keeps different producers and labels, including prefix-only coincidences", () => {
    expect(recommendationDisplay(candidate({producer:"Mar",label:"Martin Rouge"}),rec({})).title).toBe("Mar Martin Rouge");
  });
  it("uses the raw menu title when structured identity is absent", () => {
    expect(recommendationDisplay(candidate({rawText:"  Red wine   from Bordeaux "}),rec({})).title).toBe("Red wine from Bordeaux");
    expect(recommendationDisplay(undefined,{...rec({}),profile:null}).title).toBe("Unmatched wine");
  });
  it("shows compact non-redundant menu details without making a match claim", () => {
    const d=recommendationDisplay(candidate({producer:"Maison",label:"Gamay",varietal:"Gamay",region:"Loire",vintage:2022}),rec({}));
    expect(d.title).toBe("Maison Gamay"); expect(d.menuDetails).toBe("Loire · 2022");
  });
  it("suppresses inferred and duplicate profile titles but retains distinct possible matches", () => {
    const c=candidate({producer:"Domaine",label:"Rouge"});
    const base=rec({});
    expect(recommendationDisplay(c,{...base,profile:{...base.profile!,displayName:"Domaine Rouge"}}).matchedTitle).toBeNull();
    expect(recommendationDisplay(c,{...base,profile:{...base.profile!,displayName:"Other",taste:{...base.profile!.taste,sourceMode:"inferred"}}} as Recommendation).matchedTitle).toBeNull();
    expect(recommendationDisplay(c,{...base,status:"low-confidence",profile:{...base.profile!,displayName:"Other"}}).matchedTitle).toBe("Other");
  });
});
