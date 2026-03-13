import Foundation
import UniformTypeIdentifiers

struct APIClient {
    var baseURL = URL(string: "http://localhost:3001")!

    func fetchPreferences() async throws -> UserTastePreference {
        try await requestJSON(
            path: "/api/preferences",
            as: PreferencesResponse.self
        ).preferences
    }

    func savePreferences(_ preferences: UserTastePreference) async throws {
        _ = try await requestJSON(
            path: "/api/preferences",
            method: "PUT",
            body: try JSONEncoder().encode(preferences),
            contentType: "application/json",
            as: PreferencesResponse.self
        )
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

    func queueAnalysis(id: String) async throws -> CreateAnalysisResponse {
        try await requestJSON(
            path: "/api/analyses/\(id)/process",
            method: "POST",
            as: CreateAnalysisResponse.self
        )
    }

    func cancelAnalysis(id: String) async throws -> CreateAnalysisResponse {
        try await requestJSON(
            path: "/api/analyses/\(id)/cancel",
            method: "POST",
            as: CreateAnalysisResponse.self
        )
    }

    func fetchAnalysis(id: String) async throws -> AnalysisRun {
        try await requestJSON(path: "/api/analyses/\(id)", as: AnalysisRun.self)
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
            let message = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            throw APIClientError.requestFailed(statusCode: http.statusCode, message: message)
        }
    }

    private func inferMimeType(for fileURL: URL) -> String {
        if fileURL.pathExtension.lowercased() == "pdf" {
            return "application/pdf"
        }

        return UTType(filenameExtension: fileURL.pathExtension)?.preferredMIMEType ?? "image/jpeg"
    }
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
