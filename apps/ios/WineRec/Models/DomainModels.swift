import Foundation

struct TasteVector: Codable, Identifiable {
    let id = UUID()
    let body: Int
    let acidity: Int
    let tannin: Int
    let sweetness: Int
    let sourceMode: String
    let confidence: Double
}

struct WineProfile: Codable, Identifiable {
    let id: String
    let displayName: String
    let producer: String?
    let label: String?
    let vintage: Int?
    let region: String?
    let varietal: String?
    let provider: String
    let rating: Double?
    let provenanceLabel: String
    let taste: TasteVector
    let tastingNotes: String?
    let fetchedAt: String
}

struct Recommendation: Codable, Identifiable {
    var id: String { candidateId }
    let candidateId: String
    let fitScore: Double
    let matchConfidence: Double
    let profile: WineProfile?
    let status: String
}

struct WineCandidate: Codable, Identifiable {
    let id: String
    let price: String?
}

struct AnalysisRun: Codable {
    let id: String
    let sourceFilename: String
    let status: String
    let errorMessage: String?
    let candidates: [WineCandidate]
    let recommendations: [Recommendation]
}

struct TasteWeights: Codable {
    var body: Double
    var acidity: Double
    var tannin: Double
    var sweetness: Double
}

struct UserTastePreference: Codable {
    var body: Int
    var acidity: Int
    var tannin: Int
    var sweetness: Int
    var weights: TasteWeights

    static let `default` = UserTastePreference(
        body: 3,
        acidity: 5,
        tannin: 3,
        sweetness: 1,
        weights: .init(body: 0.1, acidity: 0.4, tannin: 0.1, sweetness: 0.4)
    )
}

struct PreferencesResponse: Codable {
    let preferences: UserTastePreference
}

struct UploadResponse: Codable {
    let analysisId: String
    let status: String
}
