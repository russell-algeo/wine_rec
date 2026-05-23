import Foundation
import Observation
import UniformTypeIdentifiers
import UIKit

struct AnalysisState {
    let analysisId: String
    let status: AnalysisStatus
}

@MainActor
@Observable
final class AppModel {
    private static let preferencesStorageKey = "wine-rec-preferences"
    private static let analysisPollingIntervalSeconds: Double = 1
    private static let analysisPollingStaleAfterSeconds: TimeInterval = 75

    var preferences = UserTastePreference.default
    var loadedPreferences = UserTastePreference.default
    var analysis: AnalysisRun?
    var analysisState: AnalysisState?
    var selectedFileURL: URL?
    var selectedFileName: String?
    var selectedFilePreviewData: Data?
    var selectedRecognizedText: String?
    var selectedVisionLineCount: Int?
    var sourceURLText = ""
    var pendingURL: String?
    var urlPreview: URLPreview?
    var providerHealth: [ProviderHealth] = []
    var errorMessage: String?
    var isBusy = false
    var isRunningVisionOCR = false
    var pollingPaused = false
    var pollingStatusMessage: String?

    @ObservationIgnored
    private let apiClient = APIClient()

    @ObservationIgnored
    private let visionOCRService = VisionOCRService()

    @ObservationIgnored
    private var pollingTask: Task<Void, Never>?

    @ObservationIgnored
    private let userDefaults = UserDefaults.standard

    var hasPendingSource: Bool {
        selectedFileURL != nil || selectedRecognizedText != nil || pendingURL != nil
    }

    var hasActiveAnalysis: Bool {
        guard let status = analysis?.status ?? analysisState?.status else {
            return false
        }
        return !status.isTerminal
    }

    var isLiveReranking: Bool {
        analysis != nil && !preferencesEqual(preferences, loadedPreferences)
    }

    var isFirstTimeUser: Bool {
        preferencesEqual(loadedPreferences, .default)
    }

    var selectedSourceSubtitle: String {
        if let selectedRecognizedText, !selectedRecognizedText.isEmpty {
            let lineCount = selectedVisionLineCount ?? selectedRecognizedText.split(whereSeparator: \.isNewline).count
            return "Apple Vision OCR ready - \(lineCount) recognized line\(lineCount == 1 ? "" : "s")"
        }

        return "Ready to analyze"
    }

    var providerHealthNotice: String? {
        let degraded = providerHealth.filter { !$0.enabled || $0.availability != .enabled }
        guard !degraded.isEmpty else {
            return nil
        }

        return degraded
            .map { "\($0.name): \($0.detail)" }
            .joined(separator: "\n")
    }

    deinit {
        pollingTask?.cancel()
    }

    func load() async {
        errorMessage = nil
        let storedPreferences = loadStoredPreferences()
        preferences = storedPreferences
        loadedPreferences = storedPreferences
        providerHealth = (try? await apiClient.fetchProviderHealth()) ?? []
    }

    func updatePreference(_ keyPath: WritableKeyPath<UserTastePreference, Int>, value: Int) {
        preferences[keyPath: keyPath] = value
        storePreferences(preferences)

        if analysis == nil {
            loadedPreferences = preferences
        }
    }

    func importImageData(_ data: Data, filename: String) async {
        do {
            guard let image = UIImage(data: data) else {
                errorMessage = "The selected image could not be read."
                return
            }

            isBusy = true
            isRunningVisionOCR = true
            errorMessage = nil

            let result = try await visionOCRService.recognizeText(in: image)
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString)
                .appendingPathExtension("jpg")
            try data.write(to: url, options: .atomic)
            clearPendingURL()
            selectedFileURL = url
            selectedFileName = filename
            selectedFilePreviewData = data
            selectedRecognizedText = result.recognizedText
            selectedVisionLineCount = result.lineCount
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }

        isRunningVisionOCR = false
        isBusy = false
    }

    func importCapturedImage(_ image: UIImage) async {
        guard let data = image.jpegData(compressionQuality: 0.92) else {
            errorMessage = "The captured image could not be prepared."
            return
        }

        await importImageData(data, filename: "Camera wine list.jpg")
    }

    func importDocument(from externalURL: URL) async {
        let accessed = externalURL.startAccessingSecurityScopedResource()
        defer {
            if accessed {
                externalURL.stopAccessingSecurityScopedResource()
            }
        }

        do {
            let fileExtension = externalURL.pathExtension.isEmpty ? "dat" : externalURL.pathExtension
            let destination = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString)
                .appendingPathExtension(fileExtension)

            if FileManager.default.fileExists(atPath: destination.path) {
                try FileManager.default.removeItem(at: destination)
            }

            try FileManager.default.copyItem(at: externalURL, to: destination)

            if Self.isImageFile(destination), let data = try? Data(contentsOf: destination) {
                await importImageData(data, filename: externalURL.lastPathComponent)
                return
            }

            clearPendingURL()
            selectedFileURL = destination
            selectedFileName = externalURL.lastPathComponent
            selectedFilePreviewData = Self.previewData(for: destination)
            selectedRecognizedText = nil
            selectedVisionLineCount = nil
            errorMessage = nil
        } catch {
            errorMessage = "Failed to import the selected file."
        }
    }

    func clearSelectedFile() {
        selectedFileURL = nil
        selectedFileName = nil
        selectedFilePreviewData = nil
        selectedRecognizedText = nil
        selectedVisionLineCount = nil
    }

    func confirmURL() async {
        let normalizedURL = normalizeURLInput(sourceURLText)
        guard !normalizedURL.isEmpty else {
            errorMessage = "Paste a wine list URL first."
            return
        }

        isBusy = true
        errorMessage = nil

        defer {
            isBusy = false
        }

        do {
            let preview = try await apiClient.fetchURLPreview(url: normalizedURL)
            pendingURL = normalizedURL
            urlPreview = preview
            clearSelectedFile()
        } catch {
            guard let domain = URL(string: normalizedURL)?.host else {
                errorMessage = error.localizedDescription
                return
            }

            pendingURL = normalizedURL
            urlPreview = URLPreview(title: nil, domain: domain)
            clearSelectedFile()
        }
    }

    func clearPendingURL() {
        pendingURL = nil
        urlPreview = nil
    }

    func analyzePendingSource() async {
        guard selectedFileURL != nil || pendingURL != nil else {
            errorMessage = "Choose a file or confirm a URL first."
            return
        }

        isBusy = true
        errorMessage = nil

        defer {
            isBusy = false
        }

        do {
            commitPreferencesForAnalysis()

            let created: CreateAnalysisResponse
            if let selectedRecognizedText, let selectedFileName {
                created = try await apiClient.createAnalysis(
                    fromRecognizedText: selectedRecognizedText,
                    sourceFilename: selectedFileName
                )
            } else if let selectedFileURL {
                created = try await apiClient.upload(fileURL: selectedFileURL)
            } else if let pendingURL {
                created = try await apiClient.createAnalysis(fromURL: pendingURL)
                sourceURLText = pendingURL
            } else {
                return
            }

            try await launchAnalysis(created)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func cancelCurrentAnalysis() async {
        guard let analysisId = analysis?.id ?? analysisState?.analysisId else {
            return
        }

        isBusy = true
        errorMessage = nil

        defer {
            isBusy = false
        }

        do {
            let canceled = try await apiClient.cancelAnalysis(id: analysisId)
            analysis = canceled
            analysisState = AnalysisState(analysisId: canceled.id, status: canceled.status)
            pollingTask?.cancel()
            pollingTask = nil
            pollingPaused = false
            pollingStatusMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func resumePolling() {
        guard let analysisId = analysis?.id ?? analysisState?.analysisId else {
            return
        }

        pollingPaused = false
        pollingStatusMessage = nil
        startPolling(id: analysisId)
    }

    private func commitPreferencesForAnalysis() {
        storePreferences(preferences)
        loadedPreferences = preferences
    }

    private func launchAnalysis(_ created: CreateAnalysisResponse) async throws {
        let refreshed = try await apiClient.fetchAnalysis(id: created.analysisId)
        analysis = refreshed
        analysisState = AnalysisState(analysisId: refreshed.id, status: refreshed.status)
        pollingPaused = false
        pollingStatusMessage = nil
        startPolling(id: refreshed.id)
    }

    private func startPolling(id: String) {
        pollingTask?.cancel()
        pollingTask = Task { [weak self] in
            guard let self else { return }
            await self.pollAnalysis(id: id)
        }
    }

    private func pollAnalysis(id: String) async {
        var lastSuccessfulRefresh = Date()

        while !Task.isCancelled {
            do {
                let refreshed = try await apiClient.fetchAnalysis(id: id)
                analysis = refreshed
                analysisState = AnalysisState(analysisId: refreshed.id, status: refreshed.status)
                lastSuccessfulRefresh = Date()
                pollingPaused = false
                pollingStatusMessage = nil
                errorMessage = nil

                if refreshed.status.isTerminal {
                    pollingTask = nil
                    return
                }
            } catch {
                if !Task.isCancelled {
                    if Date().timeIntervalSince(lastSuccessfulRefresh) >= Self.analysisPollingStaleAfterSeconds {
                        pollingPaused = true
                        pollingStatusMessage = "Live updates paused after repeated refresh failures."
                        pollingTask = nil
                        return
                    }

                    pollingStatusMessage = "Refreshing analysis failed. Retrying automatically."
                }
            }

            do {
                try await Task.sleep(for: .milliseconds(Int(Self.analysisPollingIntervalSeconds * 1000)))
            } catch {
                pollingTask = nil
                return
            }
        }

        pollingTask = nil
    }

    private static func previewData(for fileURL: URL) -> Data? {
        guard fileURL.pathExtension.lowercased() != "pdf" else {
            return nil
        }

        return try? Data(contentsOf: fileURL)
    }

    private static func isImageFile(_ fileURL: URL) -> Bool {
        guard let type = UTType(filenameExtension: fileURL.pathExtension) else {
            return false
        }

        return type.conforms(to: .image)
    }

    private func loadStoredPreferences() -> UserTastePreference {
        guard
            let data = userDefaults.data(forKey: Self.preferencesStorageKey),
            let stored = try? JSONDecoder().decode(UserTastePreference.self, from: data)
        else {
            return .default
        }

        return stored
    }

    private func storePreferences(_ preferences: UserTastePreference) {
        guard let data = try? JSONEncoder().encode(preferences) else {
            return
        }

        userDefaults.set(data, forKey: Self.preferencesStorageKey)
    }
}

private func normalizeURLInput(_ input: String) -> String {
    let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
        return ""
    }

    if trimmed.lowercased().hasPrefix("http://") || trimmed.lowercased().hasPrefix("https://") {
        return trimmed
    }

    return "https://\(trimmed)"
}

private func preferencesEqual(_ left: UserTastePreference, _ right: UserTastePreference) -> Bool {
    left.body == right.body &&
    left.acidity == right.acidity &&
    left.tannin == right.tannin &&
    left.sweetness == right.sweetness &&
    left.weights.body == right.weights.body &&
    left.weights.acidity == right.weights.acidity &&
    left.weights.tannin == right.weights.tannin &&
    left.weights.sweetness == right.weights.sweetness
}
