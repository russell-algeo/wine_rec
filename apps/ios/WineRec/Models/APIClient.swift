import Foundation
import UniformTypeIdentifiers

struct APIClient {
    var baseURL = URL(string: "http://localhost:3001")!

    func fetchPreferences() async throws -> UserTastePreference {
        let url = baseURL.appending(path: "/api/preferences")
        let (data, _) = try await URLSession.shared.data(from: url)
        return try JSONDecoder().decode(PreferencesResponse.self, from: data).preferences
    }

    func savePreferences(_ preferences: UserTastePreference) async throws {
        var request = URLRequest(url: baseURL.appending(path: "/api/preferences"))
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(preferences)
        _ = try await URLSession.shared.data(for: request)
    }

    func upload(fileURL: URL) async throws -> UploadResponse {
        let boundary = UUID().uuidString
        var request = URLRequest(url: baseURL.appending(path: "/api/uploads"))
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        let filename = fileURL.lastPathComponent
        let data = try Data(contentsOf: fileURL)
        let mimeType: String

        if fileURL.pathExtension.lowercased() == "pdf" {
            mimeType = "application/pdf"
        } else {
            mimeType = UTType(filenameExtension: fileURL.pathExtension)?.preferredMIMEType ?? "image/jpeg"
        }

        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body

        let (responseData, _) = try await URLSession.shared.data(for: request)
        return try JSONDecoder().decode(UploadResponse.self, from: responseData)
    }

    func queueAnalysis(id: String) async throws {
        var request = URLRequest(url: baseURL.appending(path: "/api/analyses/\(id)/process"))
        request.httpMethod = "POST"
        _ = try await URLSession.shared.data(for: request)
    }

    func fetchAnalysis(id: String) async throws -> AnalysisRun {
        let (data, _) = try await URLSession.shared.data(from: baseURL.appending(path: "/api/analyses/\(id)"))
        return try JSONDecoder().decode(AnalysisRun.self, from: data)
    }
}
