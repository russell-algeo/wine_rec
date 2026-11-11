import Foundation

@main
struct TasteEvidenceCheck {
    static func main() throws {
        func decode(_ extra: String, mode: String = "direct", confidence: Double = 0.9) throws -> TasteVector {
            let json = """
            {"body":4,"acidity":3,"tannin":4,"sweetness":1,"sourceMode":"\(mode)","confidence":\(confidence)\(extra)}
            """
            return try JSONDecoder().decode(TasteVector.self, from: Data(json.utf8))
        }
        let legacy = try decode("")
        precondition(legacy.observedDimensions == nil && !legacy.hasComparableTaste)
        let partial = try decode(",\"observedDimensions\":[\"body\"]", mode: "mapped", confidence: 0.225)
        precondition(!partial.hasComparableTaste && partial.hasUsableDimension("body") && !partial.hasUsableDimension("acidity"))
        let complete = try decode(",\"observedDimensions\":[\"body\",\"acidity\",\"tannin\",\"sweetness\"]")
        precondition(complete.hasComparableTaste)
        let none = try decode(",\"observedDimensions\":[]", mode: "mapped", confidence: 0)
        precondition(!none.hasComparableTaste && !none.hasUsableDimension("body"))
        let estimate = try decode("", mode: "inferred", confidence: 0.45)
        precondition(estimate.hasComparableTaste && estimate.hasUsableDimension("body"))
        let unknown = try decode("", mode: "inferred", confidence: 0)
        precondition(!unknown.hasComparableTaste && !unknown.hasUsableDimension("body"))
        let duplicate = try decode(",\"observedDimensions\":[\"body\",\"body\",\"body\",\"body\"]")
        precondition(!duplicate.hasComparableTaste)
        func recommendation(_ id: String, taste: TasteVector, score: Double, status: String = "matched") throws -> Recommendation {
            let tasteJSON = String(data: try JSONEncoder().encode(taste), encoding: .utf8)!
            let json = """
            {"candidateId":"\(id)","fitScore":\(score),"matchConfidence":0.9,"status":"\(status)",
             "profile":{"id":"test","displayName":"Fixture","provider":"test","provenanceLabel":"Fixture",
             "taste":\(tasteJSON),"fetchedAt":"2026-11-10T00:00:00Z"}}
            """
            return try JSONDecoder().decode(Recommendation.self, from: Data(json.utf8))
        }
        let legacyRecommendation = try recommendation("legacy", taste: legacy, score: 100)
        let verified = try recommendation("verified", taste: complete, score: 90)
        let uncertain = try recommendation("uncertain", taste: complete, score: 100, status: "low-confidence")
        precondition(!legacyRecommendation.hasComparableFit)
        precondition(!uncertain.hasComparableFit)
        precondition([legacyRecommendation, uncertain, verified].sorted(by: Recommendation.recommendedBefore).first?.candidateId == "verified")
        let zeroVerified = try recommendation("verified", taste: complete, score: 0)
        precondition([uncertain, zeroVerified].sorted(by: Recommendation.recommendedBefore).first?.candidateId == "verified")
        let estimated = try recommendation("estimate", taste: estimate, score: 70, status: "unmatched")
        precondition(estimated.hasComparableFit)
        print("Passed 7 taste-vector cases and 5 recommendation evidence/ranking checks (offline).")
    }
}
