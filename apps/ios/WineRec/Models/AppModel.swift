import Foundation
import Observation

@MainActor
@Observable
final class AppModel {
    var preferences = UserTastePreference.default
    var analysis: AnalysisRun?
    var selectedFileURL: URL?
    var errorMessage: String?
    var isBusy = false

    private let apiClient = APIClient()

    func load() async {
        do {
            preferences = try await apiClient.fetchPreferences()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func updatePreference(_ keyPath: WritableKeyPath<UserTastePreference, Int>, value: Int) {
        preferences[keyPath: keyPath] = value
    }

    func analyzeSelectedFile() async {
        guard let selectedFileURL else {
            errorMessage = "Select a file first."
            return
        }

        isBusy = true
        errorMessage = nil

        do {
            try await apiClient.savePreferences(preferences)
            let upload = try await apiClient.upload(fileURL: selectedFileURL)
            try await apiClient.queueAnalysis(id: upload.analysisId)
            try await pollAnalysis(id: upload.analysisId)
        } catch {
            errorMessage = error.localizedDescription
        }

        isBusy = false
    }

    private func pollAnalysis(id: String) async throws {
        while !Task.isCancelled {
            let next = try await apiClient.fetchAnalysis(id: id)
            analysis = next
            if next.status == "completed" || next.status == "failed" || next.status == "canceled" {
                return
            }
            try await Task.sleep(for: .seconds(1))
        }
    }
}
