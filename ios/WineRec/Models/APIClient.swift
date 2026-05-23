import Foundation
import UniformTypeIdentifiers

struct APIClient {
    private let baseURL: URL

    init(baseURL: URL = APIClient.resolveBaseURL()) {
        self.baseURL = baseURL
    }

    func fetchProviderHealth() async throws -> [ProviderHealth] {
        try await requestJSON(path: "/api/health/providers", as: [ProviderHealth].self)
    }

    func fetchURLPreview(url: String) async throws -> URLPreview {
        let encoded = url.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? url
        return try await requestJSON(path: "/api/preview?url=\(encoded)", as: URLPreview.self)
    }

    func upload(fileURL: URL) async throws -> CreateAnalysisResponse {
        let boundary = UUID().uuidString
        var request = URLRequest(url: baseURL.appending(path: "/api/uploads"))
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        let filename = fileURL.lastPathComponent
        let data = try Data(contentsOf: fileURL)
        let mimeType = inferMimeType(for: fileURL)

        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body

        return try await performJSON(request: request, as: CreateAnalysisResponse.self)
    }

    func createAnalysis(fromURL url: String) async throws -> CreateAnalysisResponse {
        try await requestJSON(
            path: "/api/urls",
            method: "POST",
            body: try JSONEncoder().encode(["url": url]),
            contentType: "application/json",
            as: CreateAnalysisResponse.self
        )
    }

    func createAnalysis(fromRecognizedText recognizedText: String, sourceFilename: String) async throws -> CreateAnalysisResponse {
        try await requestJSON(
            path: "/api/client-ocr",
            method: "POST",
            body: try JSONEncoder().encode(ClientOCRRequest(
                sourceFilename: sourceFilename,
                recognizedText: recognizedText
            )),
            contentType: "application/json",
            as: CreateAnalysisResponse.self
        )
    }

    func fetchAnalysis(id: String) async throws -> AnalysisRun {
        try await requestJSON(path: "/api/analyses/\(id)", as: AnalysisRun.self)
    }

    func cancelAnalysis(id: String) async throws -> AnalysisRun {
        try await requestJSON(path: "/api/analyses/\(id)/cancel", method: "POST", as: AnalysisRun.self)
    }

    private func requestJSON<T: Decodable>(
        path: String,
        method: String = "GET",
        body: Data? = nil,
        contentType: String? = nil,
        as type: T.Type
    ) async throws -> T {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.httpBody = body

        if let contentType {
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }

        return try await performJSON(request: request, as: type)
    }

    private func performJSON<T: Decodable>(request: URLRequest, as type: T.Type) async throws -> T {
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response: response, data: data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func validate(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else {
            throw APIClientError.invalidResponse
        }

        guard (200..<300).contains(http.statusCode) else {
            let message = decodeErrorMessage(from: data) ??
                String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            throw APIClientError.requestFailed(statusCode: http.statusCode, message: message)
        }
    }

    private func decodeErrorMessage(from data: Data) -> String? {
        guard !data.isEmpty else {
            return nil
        }

        let envelope = try? JSONDecoder().decode(APIErrorEnvelope.self, from: data)
        return envelope?.message?.nilIfEmpty ?? envelope?.error?.nilIfEmpty
    }

    private func inferMimeType(for fileURL: URL) -> String {
        if fileURL.pathExtension.lowercased() == "pdf" {
            return "application/pdf"
        }

        return UTType(filenameExtension: fileURL.pathExtension)?.preferredMIMEType ?? "image/jpeg"
    }

    private static func resolveBaseURL() -> URL {
        if
            let override = ProcessInfo.processInfo.environment["WINE_REC_API_BASE_URL"],
            let url = URL(string: override),
            url.scheme?.isEmpty == false,
            url.host?.isEmpty == false
        {
            return url
        }

        if
            let configured = Bundle.main.object(forInfoDictionaryKey: "WineRecAPIBaseURL") as? String,
            let url = URL(string: configured),
            url.scheme?.isEmpty == false,
            url.host?.isEmpty == false
        {
            return url
        }

        if
            let configured = Bundle.main.object(forInfoDictionaryKey: "WINE_REC_API_BASE_URL") as? String,
            let url = URL(string: configured),
            url.scheme?.isEmpty == false,
            url.host?.isEmpty == false
        {
            return url
        }

        return URL(string: "https://wine-rec.vercel.app")!
    }
}

private struct ClientOCRRequest: Encodable {
    let sourceFilename: String
    let recognizedText: String
}

private struct APIErrorEnvelope: Decodable {
    let message: String?
    let error: String?
}

enum APIClientError: LocalizedError {
    case invalidResponse
    case requestFailed(statusCode: Int, message: String?)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "The server returned an invalid response."
        case let .requestFailed(statusCode, message):
            if let message, !message.isEmpty {
                return "Request failed with \(statusCode): \(message)"
            }

            return "Request failed with \(statusCode)."
        }
    }
}

private extension String {
    var nilIfEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
