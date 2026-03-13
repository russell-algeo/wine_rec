import Foundation

enum SourceType: String, Codable, Equatable {
    case uploadImage = "upload-image"
    case uploadPDF = "upload-pdf"
    case urlHTML = "url-html"
    case urlPDF = "url-pdf"
    case siteCrawl = "site-crawl"
}

enum SourceMode: String, Codable, Equatable {
    case direct
    case mapped
    case inferred
}

enum AnalysisStatus: String, Codable, Equatable {
    case uploaded
    case queued
    case processing
    case canceled
    case completed
    case failed

    var isTerminal: Bool {
        switch self {
        case .canceled, .completed, .failed:
            return true
        case .uploaded, .queued, .processing:
            return false
        }
    }
}

enum ProviderAvailability: String, Codable, Equatable {
    case enabled
    case disabled
    case degraded
}

enum WineRatingSource: String, Codable, Equatable {
    case vintage
    case wine
}

enum RecommendationStatus: String, Codable, Equatable {
    case matched
    case lowConfidence = "low-confidence"
    case unmatched

    var label: String {
        switch self {
        case .matched:
            return "Matched"
        case .lowConfidence:
            return "Low confidence"
        case .unmatched:
            return "Unmatched"
        }
    }
}

struct TastingNoteGroup: Codable, Identifiable {
    var id: String { key }

    let key: String
    let label: String
    let score: Double?
    let noteCount: Int
    let keywords: [String]
    let keywordImageUrls: [String?]
    let color: String?
    let imageUrl: String?
}

struct TasteVector: Codable {
    let body: Int
    let acidity: Int
    let tannin: Int
    let sweetness: Int
    let sourceMode: SourceMode
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
    let ratingCount: Int?
    let ratingSource: WineRatingSource?
    let imageUrl: String?
    let provenanceLabel: String
    let taste: TasteVector
    let tasteReviewCount: Int?
    let tastingNotes: String?
    let tastingNoteGroups: [TastingNoteGroup]?
    let retailPrice: Double?
    let fetchedAt: String
}

struct Recommendation: Codable, Identifiable {
    var id: String { candidateId }

    let candidateId: String
    let fitScore: Double
    let matchConfidence: Double
    let profile: WineProfile?
    let status: RecommendationStatus
}

struct WineCandidate: Codable, Identifiable {
    let id: String
    let rawText: String
    let price: String?
    let menuTab: String?
    let menuSection: String?
    let lineNumber: Int
    let producer: String?
    let label: String?
    let vintage: Int?
    let color: String?
    let varietal: String?
    let region: String?
    let notes: String?
    let extractionConfidence: Double
}

struct AnalysisRun: Codable, Identifiable {
    let id: String
    let sourceType: SourceType
    let sourceFilename: String
    let status: AnalysisStatus
    let errorMessage: String?
    let createdAt: String
    let updatedAt: String
    let extractedText: String?
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

struct CreateAnalysisResponse: Codable {
    let analysisId: String
    let status: AnalysisStatus
}

typealias UploadResponse = CreateAnalysisResponse

struct URLPreview: Codable {
    let title: String?
    let domain: String
}

struct ProviderHealth: Codable, Identifiable {
    var id: String { name }

    let name: String
    let availability: ProviderAvailability
    let enabled: Bool
    let detail: String
}
