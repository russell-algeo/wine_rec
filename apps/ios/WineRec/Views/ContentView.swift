import SwiftUI
import PhotosUI

struct ContentView: View {
    @Environment(AppModel.self) private var model
    @State private var selectedPhotoItem: PhotosPickerItem?
    @State private var selectedDocument: URL?
    @State private var showingImporter = false
    @State private var resultSortOrder = ResultSortOrder.recommended

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    header
                    preferencesCard
                    uploadCard
                    resultsCard
                }
                .padding(20)
            }
            .background(
                LinearGradient(
                    colors: [Color(red: 0.96, green: 0.92, blue: 0.86), Color(red: 0.97, green: 0.95, blue: 0.92)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
                .ignoresSafeArea()
            )
            .navigationTitle("Wine Rec")
        }
        .task {
            await model.load()
        }
        .fileImporter(
            isPresented: $showingImporter,
            allowedContentTypes: [.pdf, .image],
            allowsMultipleSelection: false
        ) { result in
            if case let .success(urls) = result {
                selectedDocument = urls.first
                model.selectedFileURL = urls.first
            }
        }
        .onChange(of: selectedPhotoItem) { _, newValue in
            guard let newValue else { return }
            Task {
                if let data = try? await newValue.loadTransferable(type: Data.self) {
                    let temporaryURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".jpg")
                    try? data.write(to: temporaryURL)
                    selectedDocument = temporaryURL
                    model.selectedFileURL = temporaryURL
                }
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Upload-first wine matching for crisp, dry preferences.")
                .font(.system(.largeTitle, design: .serif, weight: .bold))
            Text("Bring in a restaurant wine list or store PDF, then rank the likely matches by fit.")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var preferencesCard: some View {
        CardView(title: "Preference Vector") {
            PreferenceRow(title: "Acidity", value: model.preferences.acidity) { model.updatePreference(\.acidity, value: $0) }
            PreferenceRow(title: "Sweetness", value: model.preferences.sweetness) { model.updatePreference(\.sweetness, value: $0) }
            PreferenceRow(title: "Body", value: model.preferences.body) { model.updatePreference(\.body, value: $0) }
            PreferenceRow(title: "Tannin", value: model.preferences.tannin) { model.updatePreference(\.tannin, value: $0) }
        }
    }

    private var uploadCard: some View {
        CardView(title: "Upload") {
            VStack(alignment: .leading, spacing: 12) {
                PhotosPicker(selection: $selectedPhotoItem, matching: .images) {
                    Label("Choose Photo", systemImage: "photo")
                }
                Button("Choose Image or PDF") {
                    showingImporter = true
                }
                .buttonStyle(.bordered)

                if let selectedDocument {
                    Text(selectedDocument.lastPathComponent)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Button {
                    Task {
                        await model.analyzeSelectedFile()
                    }
                } label: {
                    if model.isBusy {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    } else {
                        Text("Analyze Wine List")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)

                if let errorMessage = model.errorMessage {
                    Text(errorMessage)
                        .foregroundStyle(.red)
                        .font(.footnote)
                }
            }
        }
    }

    private var resultsCard: some View {
        CardView(title: "Results") {
            if let analysis = model.analysis {
                VStack(alignment: .leading, spacing: 12) {
                    Text("\(analysis.sourceFilename) · \(analysis.status)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)

                    if !analysis.recommendations.isEmpty {
                        Picker("Sort by", selection: $resultSortOrder) {
                            ForEach(ResultSortOrder.allCases) { sortOrder in
                                Text(sortOrder.label).tag(sortOrder)
                            }
                        }
                        .pickerStyle(.segmented)
                    }

                    ForEach(sortedRecommendations(for: analysis)) { recommendation in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(recommendation.profile?.displayName ?? "Unmatched wine")
                                        .font(.headline)
                                    Text(recommendation.profile?.provenanceLabel ?? recommendation.status)
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text("\(Int(recommendation.fitScore))")
                                    .font(.title3.bold())
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 8)
                                    .background(Color(red: 0.55, green: 0.15, blue: 0.24).opacity(0.12))
                                    .clipShape(Capsule())
                            }

                            HStack {
                                MetricCapsule(label: "Acidity", value: recommendation.profile?.taste.acidity ?? 0)
                                MetricCapsule(label: "Sweetness", value: recommendation.profile?.taste.sweetness ?? 0)
                                MetricCapsule(label: "Body", value: recommendation.profile?.taste.body ?? 0)
                                MetricCapsule(label: "Tannin", value: recommendation.profile?.taste.tannin ?? 0)
                            }

                            if let notes = recommendation.profile?.tastingNotes {
                                Text(notes)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .padding(14)
                        .background(Color.white.opacity(0.7))
                        .clipShape(RoundedRectangle(cornerRadius: 18))
                    }
                }
            } else {
                Text("No analysis yet.")
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func sortedRecommendations(for analysis: AnalysisRun) -> [Recommendation] {
        switch resultSortOrder {
        case .recommended:
            return analysis.recommendations
        case .discovered:
            let discoveredOrder = Dictionary(
                uniqueKeysWithValues: analysis.candidates.enumerated().map { ($1.id, $0) }
            )
            let rankedOrder = Dictionary(
                uniqueKeysWithValues: analysis.recommendations.enumerated().map { ($1.candidateId, $0) }
            )

            return analysis.recommendations.sorted { left, right in
                let leftDiscovered = discoveredOrder[left.candidateId] ?? Int.max
                let rightDiscovered = discoveredOrder[right.candidateId] ?? Int.max

                if leftDiscovered != rightDiscovered {
                    return leftDiscovered < rightDiscovered
                }

                return (rankedOrder[left.candidateId] ?? Int.max) < (rankedOrder[right.candidateId] ?? Int.max)
            }
        }
    }
}

private enum ResultSortOrder: String, CaseIterable, Identifiable {
    case recommended
    case discovered

    var id: Self { self }

    var label: String {
        switch self {
        case .recommended:
            return "Most Recommended"
        case .discovered:
            return "Image Order"
        }
    }
}

private struct CardView<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title)
                .font(.system(.title3, design: .serif, weight: .semibold))
            content
        }
        .padding(20)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 28))
    }
}

private struct PreferenceRow: View {
    let title: String
    let value: Int
    let onChange: (Int) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title)
                Spacer()
                Text("\(value)")
                    .foregroundStyle(.secondary)
            }
            Slider(value: Binding(
                get: { Double(value) },
                set: { onChange(Int($0.rounded())) }
            ), in: 1...5, step: 1)
            .tint(Color(red: 0.55, green: 0.15, blue: 0.24))
        }
    }
}

private struct MetricCapsule: View {
    let label: String
    let value: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value == 0 ? "—" : "\(value)")
                .font(.headline)
        }
        .padding(10)
        .background(Color(red: 0.97, green: 0.93, blue: 0.89))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}
