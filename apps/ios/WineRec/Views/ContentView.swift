import SwiftUI
import PhotosUI

struct ContentView: View {
    @Environment(AppModel.self) private var model
    @State private var selectedPhotoItem: PhotosPickerItem?
    @State private var selectedDocument: URL?
    @State private var showingImporter = false
    @State private var resultSortOrder = ResultSortOrder.recommended
    @State private var maxPriceFilter: Double?
    @State private var includePriceUnavailable = true

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
        .onChange(of: model.analysis?.id) { _, _ in
            maxPriceFilter = nil
            includePriceUnavailable = true
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
                let candidateById = Dictionary(uniqueKeysWithValues: analysis.candidates.map { ($0.id, $0) })
                let displayedRecommendations = filteredRecommendations(for: analysis, candidateById: candidateById)
                let priceBounds = priceFilterBounds(for: analysis)
                let effectiveMaxPrice = priceBounds.map { maxPriceFilter ?? $0.max }

                VStack(alignment: .leading, spacing: 12) {
                    Text("\(analysis.sourceFilename) · \(analysis.status)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)

                    if let progress = analysisProgress(for: analysis), progress.status != "completed" {
                        AnalysisProgressCard(progress: progress)
                    }

                    if !analysis.recommendations.isEmpty {
                        Picker("Sort by", selection: $resultSortOrder) {
                            ForEach(ResultSortOrder.allCases) { sortOrder in
                                Text(sortOrder.label).tag(sortOrder)
                            }
                        }
                        .pickerStyle(.segmented)

                        if let priceBounds, let effectiveMaxPrice {
                            VStack(alignment: .leading, spacing: 8) {
                                HStack {
                                    Text("Budget")
                                        .font(.caption)
                                        .fontWeight(.bold)
                                        .textCase(.uppercase)
                                        .foregroundStyle(Color(red: 0.55, green: 0.15, blue: 0.24))
                                    Spacer()
                                    Text(effectiveMaxPrice < priceBounds.max
                                        ? "\(formatPriceValue(effectiveMaxPrice)) and under"
                                        : "Any price")
                                        .font(.subheadline.weight(.semibold))
                                }

                                Slider(
                                    value: Binding(
                                        get: { effectiveMaxPrice },
                                        set: { maxPriceFilter = $0 }
                                    ),
                                    in: priceBounds.min...priceBounds.max,
                                    step: 1
                                )
                                .tint(Color(red: 0.55, green: 0.15, blue: 0.24))

                                HStack {
                                    Text("\(formatPriceValue(priceBounds.min)) to \(formatPriceValue(priceBounds.max))")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    Spacer()
                                    Text(priceBounds.missingCount > 0 ? "\(priceBounds.missingCount) unpriced" : "All priced")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }

                                Toggle(
                                    "Include wines without price\(priceBounds.missingCount > 0 ? " (\(priceBounds.missingCount))" : "")",
                                    isOn: $includePriceUnavailable
                                )
                                .font(.footnote)
                                .tint(Color(red: 0.55, green: 0.15, blue: 0.24))
                            }
                            .padding(14)
                            .background(Color.white.opacity(0.68))
                            .clipShape(RoundedRectangle(cornerRadius: 18))
                        }
                    }

                    if displayedRecommendations.isEmpty && !analysis.recommendations.isEmpty {
                        Text("No wines match the current filters.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    ForEach(displayedRecommendations) { recommendation in
                        let candidate = candidateById[recommendation.candidateId]
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
                                VStack(alignment: .trailing, spacing: 8) {
                                    Text(candidate?.price ?? "Price unavailable")
                                        .font(.footnote.weight(.semibold))
                                        .foregroundStyle(candidate?.price == nil ? .secondary : .primary)
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 6)
                                        .background(Color.white.opacity(0.8))
                                        .clipShape(Capsule())

                                    Text("\(Int(recommendation.fitScore))")
                                        .font(.title3.bold())
                                        .padding(.horizontal, 12)
                                        .padding(.vertical, 8)
                                        .background(Color(red: 0.55, green: 0.15, blue: 0.24).opacity(0.12))
                                        .clipShape(Capsule())
                                }
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

    private func filteredRecommendations(
        for analysis: AnalysisRun,
        candidateById: [String: WineCandidate]
    ) -> [Recommendation] {
        let sorted = sortedRecommendations(for: analysis)
        guard let priceBounds = priceFilterBounds(for: analysis) else {
            return sorted
        }

        let effectiveMaxPrice = maxPriceFilter ?? priceBounds.max
        return sorted.filter { recommendation in
            let parsedPrice = parsePrice(candidateById[recommendation.candidateId]?.price)

            if let parsedPrice {
                return parsedPrice <= effectiveMaxPrice
            }

            return includePriceUnavailable
        }
    }
}

private struct PriceFilterBounds {
    let min: Double
    let max: Double
    let missingCount: Int
}

private func priceFilterBounds(for analysis: AnalysisRun) -> PriceFilterBounds? {
    let parsedPrices = analysis.candidates.compactMap { parsePrice($0.price) }
    guard !parsedPrices.isEmpty else {
        return nil
    }

    return PriceFilterBounds(
        min: max(0, floor(parsedPrices.min() ?? 0)),
        max: ceil(parsedPrices.max() ?? 0),
        missingCount: analysis.candidates.count - parsedPrices.count
    )
}

private func parsePrice(_ rawPrice: String?) -> Double? {
    guard let rawPrice,
          let range = rawPrice.range(of: #"\d+(?:\.\d{1,2})?"#, options: .regularExpression)
    else {
        return nil
    }

    return Double(rawPrice[range])
}

private func formatPriceValue(_ value: Double) -> String {
    if value.rounded() == value {
        return String(format: "$%.0f", value)
    }

    return String(format: "$%.2f", value)
}

private struct AnalysisProgressState {
    let title: String
    let detail: String
    let processed: Int
    let total: Int
    let fraction: Double?
    let status: String
}

private func analysisProgress(for analysis: AnalysisRun) -> AnalysisProgressState? {
    if analysis.status == "uploaded" || analysis.status == "queued" {
        return AnalysisProgressState(
            title: "Queued for processing",
            detail: "Waiting for OCR and parsing to start.",
            processed: 0,
            total: 0,
            fraction: nil,
            status: analysis.status
        )
    }

    let total = analysis.candidates.count
    let processed = min(analysis.recommendations.count, total)

    if analysis.status == "processing" {
        if total == 0 {
            return AnalysisProgressState(
                title: "Running OCR",
                detail: "Extracting text and counting wine entries before matching begins.",
                processed: 0,
                total: 0,
                fraction: nil,
                status: analysis.status
            )
        }

        return AnalysisProgressState(
            title: "Analyzing \(processed) of \(total) wines",
            detail: processed == 0
                ? "OCR is done. The app is now matching each wine and fetching taste data."
                : "Progress updates as each wine finishes processing.",
            processed: processed,
            total: total,
            fraction: total > 0 ? Double(processed) / Double(total) : nil,
            status: analysis.status
        )
    }

    if analysis.status == "failed" {
        return AnalysisProgressState(
            title: "Analysis failed",
            detail: analysis.errorMessage ?? "The worker stopped before finishing the wine list.",
            processed: processed,
            total: total,
            fraction: total > 0 ? Double(processed) / Double(total) : nil,
            status: analysis.status
        )
    }

    if analysis.status == "canceled" {
        return AnalysisProgressState(
            title: total > 0
                ? "Analysis stopped at \(processed) of \(total) wines"
                : "Analysis stopped",
            detail: total > 0
                ? "This run was stopped. Any recommendations shown below are partial results."
                : "This run was stopped before OCR and wine matching finished.",
            processed: processed,
            total: total,
            fraction: total > 0 ? Double(processed) / Double(total) : nil,
            status: analysis.status
        )
    }

    return nil
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

private struct AnalysisProgressCard: View {
    let progress: AnalysisProgressState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(progress.title)
                        .font(.caption)
                        .fontWeight(.bold)
                        .textCase(.uppercase)
                        .foregroundStyle(Color(red: 0.55, green: 0.15, blue: 0.24))
                    Text(progress.detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Group {
                    if progress.total > 0 {
                        Text("\(progress.processed)/\(progress.total)")
                    } else if progress.status == "canceled" {
                        Text("Stopped")
                    } else if progress.status == "failed" {
                        Text("Failed")
                    } else {
                        Text("OCR")
                    }
                }
                .font(.headline)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Color(red: 0.55, green: 0.15, blue: 0.24).opacity(0.12))
                .clipShape(Capsule())
            }

            if let fraction = progress.fraction, progress.total > 0 {
                ProgressView(value: fraction)
                    .tint(progress.status == "failed"
                        ? .red
                        : Color(red: 0.55, green: 0.15, blue: 0.24))
            } else {
                ProgressView()
                    .tint(progress.status == "failed"
                        ? .red
                        : Color(red: 0.55, green: 0.15, blue: 0.24))
            }
        }
        .padding(14)
        .background(Color.white.opacity(progress.status == "failed" ? 0.8 : 0.68))
        .clipShape(RoundedRectangle(cornerRadius: 18))
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
