import PhotosUI
import SwiftUI
import UIKit

private let allResultSectionsId = "__all_sections__"
private enum AppArtwork {
    static let hero = "HeroBackground"
    static let bottlesBreak = "StoryBottles"
    static let shelfBreak = "StoryShelf"
}

struct ContentView: View {
    @Environment(AppModel.self) private var model

    @State private var selectedPhotoItem: PhotosPickerItem?
    @State private var showingImporter = false
    @State private var showingTastePanel = false
    @State private var showingResultsTastePanel = false
    @State private var resultSortOrder = ResultSortOrder.recommended
    @State private var resultProfileFilter = ResultProfileFilter.excludeInferred
    @State private var selectedResultSectionId = allResultSectionsId
    @State private var maxPriceFilter: Double?
    @State private var includePriceUnavailable = true

    private var heroHeight: CGFloat {
        min(max(UIScreen.main.bounds.height * 0.56, 430), 580)
    }

    private func confirmPendingURL() {
        Task {
            await model.confirmURL()
        }
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                GeometryReader { geometry in
                    ZStack(alignment: .top) {
                        AppBackground()

                        ScrollView(.vertical, showsIndicators: false) {
                            VStack(spacing: 28) {
                                heroSection(proxy: proxy)
                                    .id("hero")

                                ingestSection
                                    .padding(.horizontal, 20)
                                    .id("ingest")

                                StoryImageBreakCard(
                                    title: "EVERY LIST.\nEVERY BOTTLE.\nRANKED FOR YOU.",
                                    imageName: AppArtwork.bottlesBreak,
                                    isLeading: true
                                )

                                resultsSection
                                    .padding(.horizontal, 20)
                                    .id("results")

                                StoryImageBreakCard(
                                    title: "CURATED BY DATA.\nCHOSEN BY TASTE.",
                                    imageName: AppArtwork.shelfBreak,
                                    isLeading: true
                                )
                            }
                            .frame(width: geometry.size.width, alignment: .top)
                            .padding(.bottom, 40)
                        }

                        topBar

                        if showingTastePanel {
                            tasteDrawer
                                .padding(.horizontal, 20)
                                .padding(.top, 72)
                                .transition(.move(edge: .top).combined(with: .opacity))
                        }
                    }
                }
                .toolbar(.hidden, for: .navigationBar)
                .task {
                    await model.load()
                }
                .fileImporter(
                    isPresented: $showingImporter,
                    allowedContentTypes: [.pdf, .image],
                    allowsMultipleSelection: false
                ) { result in
                    guard case let .success(urls) = result, let url = urls.first else {
                        return
                    }

                    Task {
                        await model.importDocument(from: url)
                    }
                }
                .onChange(of: selectedPhotoItem) { _, newValue in
                    guard let newValue else { return }
                    Task {
                        if let data = try? await newValue.loadTransferable(type: Data.self) {
                            model.setSelectedPhotoData(data)
                        }
                    }
                }
                .onChange(of: model.analysis?.id) { _, _ in
                    maxPriceFilter = nil
                    includePriceUnavailable = true
                    selectedResultSectionId = allResultSectionsId
                }
                .onChange(of: model.analysisState?.analysisId) { _, newValue in
                    guard newValue != nil else { return }
                    withAnimation(.spring(response: 0.52, dampingFraction: 0.9)) {
                        proxy.scrollTo("results", anchor: .top)
                    }
                }
            }
        }
    }

    private var topBar: some View {
        HStack(spacing: 14) {
            Text("Wine Rec")
                .font(.system(size: 18, weight: .black, design: .serif))
                .tracking(-0.3)
                .foregroundStyle(AppPalette.ink)

            Spacer()

            Button(showingTastePanel ? "Close" : "My Taste") {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.82)) {
                    showingTastePanel.toggle()
                }
            }
            .buttonStyle(OutlineActionButtonStyle())
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
        .background(AppPalette.background.opacity(0.92), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(AppPalette.line, lineWidth: 1)
                .allowsHitTesting(false)
        )
        .shadow(color: .black.opacity(0.05), radius: 14, y: 6)
        .padding(.horizontal, 20)
        .padding(.top, 10)
    }

    private var tasteDrawer: some View {
        SurfaceCard {
            VStack(alignment: .leading, spacing: 18) {
                Text("How should your wine taste?")
                    .font(.system(size: 22, weight: .black, design: .serif))
                    .foregroundStyle(AppPalette.ink)

                VStack(spacing: 16) {
                    interactiveTasteScale(for: .body)
                    interactiveTasteScale(for: .tannin)
                    interactiveTasteScale(for: .sweetness)
                    interactiveTasteScale(for: .acidity)
                }

                Text("Preferences apply automatically on your next analysis.")
                    .font(.footnote)
                    .foregroundStyle(AppPalette.muted)
            }
        }
        .shadow(color: .black.opacity(0.08), radius: 18, y: 10)
    }

    private func heroSection(proxy: ScrollViewProxy) -> some View {
        ZStack {
            Image(AppArtwork.hero)
                .resizable()
                .scaledToFill()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay {
                    LinearGradient(
                        colors: [
                            Color.black.opacity(0.08),
                            Color.black.opacity(0.16),
                            Color.black.opacity(0.62)
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                }
                .overlay(alignment: .top) {
                    LinearGradient(
                        colors: [Color.black.opacity(0.18), .clear],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                    .frame(height: 140)
                }
        }
        .frame(maxWidth: .infinity)
        .frame(height: heroHeight)
        .overlay(alignment: .bottomLeading) {
            VStack(alignment: .leading, spacing: 18) {
                Text("WINE\nREC")
                    .font(.system(size: 46, weight: .black, design: .serif))
                    .foregroundStyle(.white)
                    .tracking(-1.3)
                    .lineSpacing(-8)
                    .multilineTextAlignment(.leading)

                Text("Find the best bottle on any wine list.")
                    .font(.system(size: 19, weight: .semibold, design: .default))
                    .foregroundStyle(Color.white.opacity(0.88))
                    .frame(maxWidth: 240, alignment: .leading)

                Button("Get Started") {
                    withAnimation(.spring(response: 0.5, dampingFraction: 0.9)) {
                        proxy.scrollTo("ingest", anchor: .top)
                    }
                }
                .buttonStyle(PrimaryActionButtonStyle())
            }
            .frame(maxWidth: 240, alignment: .leading)
            .padding(.leading, 24)
            .padding(.bottom, 30)
        }
        .clipped()
    }

    private var ingestSection: some View {
        SurfaceCard {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("What's on the list?")
                        .font(.system(size: 28, weight: .black, design: .serif))
                        .foregroundStyle(AppPalette.ink)
                    Text("Paste a link or bring in a photo, screenshot, or PDF of any wine list.")
                        .font(.body)
                        .foregroundStyle(AppPalette.muted)
                }

                urlInputControls
                .padding(5)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(AppPalette.line, lineWidth: 1.2)
                        .allowsHitTesting(false)
                )

                if let urlPreview = model.urlPreview {
                    URLPreviewCard(preview: urlPreview, urlString: model.pendingURL ?? model.sourceURLText)
                }

                DividerLabel(text: "OR")

                SourceChooserCard {
                    VStack(spacing: 16) {
                        VStack(spacing: 8) {
                            Image(systemName: "square.and.arrow.down")
                                .font(.system(size: 20, weight: .semibold))
                                .foregroundStyle(AppPalette.accentBlue)

                            Text("Bring in a photo, screenshot, or PDF")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(AppPalette.ink)
                                .multilineTextAlignment(.center)

                            Text("Choose from Photos or Files")
                                .font(.footnote)
                                .foregroundStyle(AppPalette.muted)
                        }

                        sourceSelectionControls
                    }
                }

                if model.selectedFileURL != nil {
                    SelectedSourceCard(
                        title: model.selectedFileName ?? "Selected file",
                        subtitle: "Ready to analyze",
                        previewData: model.selectedFilePreviewData
                    ) {
                        model.clearSelectedFile()
                    }
                }

                if model.hasPendingSource {
                    VStack(alignment: .leading, spacing: 16) {
                        Text(model.isFirstTimeUser ? "How do you like your wine?" : "Your preferences are saved.")
                            .font(.system(size: 20, weight: .heavy, design: .serif))
                            .foregroundStyle(AppPalette.ink)

                        Text(model.isFirstTimeUser
                             ? "Set your preferences now. Results will be ranked to match."
                             : "Adjust if needed, then start the analysis.")
                            .font(.subheadline)
                            .foregroundStyle(AppPalette.muted)

                        VStack(spacing: 16) {
                            interactiveTasteScale(for: .body)
                            interactiveTasteScale(for: .tannin)
                            interactiveTasteScale(for: .sweetness)
                            interactiveTasteScale(for: .acidity)
                        }

                        Button(model.isBusy ? "Starting..." : "Analyze") {
                            Task {
                                await model.analyzePendingSource()
                            }
                        }
                        .buttonStyle(PrimaryActionButtonStyle(fullWidth: true))
                        .disabled(model.isBusy)
                    }
                    .padding(20)
                    .background(AppPalette.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .stroke(AppPalette.line, lineWidth: 1)
                    )
                }

                if let errorMessage = model.errorMessage {
                    StatusNotice(
                        title: "Something needs attention",
                        message: errorMessage,
                        tint: AppPalette.accentRed.opacity(0.16),
                        stroke: AppPalette.accentRed.opacity(0.24)
                    )
                }

                if let analysisState = model.analysisState {
                    Text("Analysis \(analysisState.analysisId.prefix(8)) · \(analysisState.status.rawValue)")
                        .font(.caption.weight(.bold))
                        .textCase(.uppercase)
                        .tracking(0.8)
                        .foregroundStyle(AppPalette.muted)
                }
            }
        }
    }

    private var urlInputControls: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                urlTextField
                nextButton(fullWidth: false)
            }

            VStack(spacing: 10) {
                urlTextField
                nextButton(fullWidth: true)
            }
        }
    }

    private var urlTextField: some View {
        TextField(
            "Paste a wine list URL",
            text: Binding(
                get: { model.sourceURLText },
                set: { model.sourceURLText = $0 }
            )
        )
        .textInputAutocapitalization(.never)
        .keyboardType(.URL)
        .autocorrectionDisabled(true)
        .submitLabel(.go)
        .onSubmit(confirmPendingURL)
        .padding(.horizontal, 16)
        .padding(.vertical, 15)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func nextButton(fullWidth: Bool) -> some View {
        Button(model.isBusy ? "Loading..." : "Next", action: confirmPendingURL)
            .buttonStyle(CompactPrimaryActionButtonStyle(fullWidth: fullWidth))
            .disabled(model.isBusy)
    }

    private var sourceSelectionControls: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) {
                photoPickerButton
                filePickerButton
            }

            VStack(spacing: 12) {
                photoPickerButton
                filePickerButton
            }
        }
    }

    private var photoPickerButton: some View {
        PhotosPicker(selection: $selectedPhotoItem, matching: .images) {
            Label("Photos", systemImage: "photo")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(OutlineActionButtonStyle())
    }

    private var filePickerButton: some View {
        Button {
            showingImporter = true
        } label: {
            Label("Files", systemImage: "doc.badge.plus")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(OutlineActionButtonStyle())
    }

    private var resultsSection: some View {
        let analysis = model.analysis
        let baseRecommendations = rerankedRecommendations(analysis: analysis, preferences: model.preferences, useLiveReranking: model.isLiveReranking)
        let sortedRecommendations = sortRecommendations(
            recommendations: baseRecommendations,
            candidates: analysis?.candidates ?? [],
            sortOrder: resultSortOrder
        )
        let inferredRecommendationCount = sortedRecommendations.filter(isInferredRecommendation).count
        let candidateById = Dictionary(uniqueKeysWithValues: (analysis?.candidates ?? []).map { ($0.id, $0) })
        let priceBounds = getPriceFilterBounds(candidates: analysis?.candidates ?? [])
        let effectiveMaxPrice = priceBounds.map { maxPriceFilter ?? $0.max }
        let profileFiltered = filterRecommendationsByProfileSource(
            recommendations: sortedRecommendations,
            filter: resultProfileFilter
        )
        let priceFiltered = filterRecommendationsByPrice(
            recommendations: profileFiltered,
            candidateById: candidateById,
            maxPrice: effectiveMaxPrice,
            includeUnavailable: includePriceUnavailable
        )
        let hiddenByPriceCount = profileFiltered.count - priceFiltered.count
        let resultSections = buildResultSections(
            analysis: analysis,
            recommendations: priceFiltered,
            candidateById: candidateById
        )
        let hasStructuredResults = resultSections.contains { $0.menuTab != nil || $0.menuSection != nil }
        let visibleResultSections = resolvedVisibleSections(
            allSections: resultSections,
            selectedResultSectionId: selectedResultSectionId
        )
        let analysisProgress = getAnalysisProgress(analysis: analysis)
        let isPriceFilterActive = isBudgetFilterActive(
            bounds: priceBounds,
            effectiveMaxPrice: effectiveMaxPrice,
            includeUnavailable: includePriceUnavailable
        )

        return SurfaceCard {
            VStack(alignment: .leading, spacing: 22) {
                if analysis != nil {
                    Button {
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.84)) {
                            showingResultsTastePanel.toggle()
                        }
                    } label: {
                        HStack(spacing: 10) {
                            Text("My Taste Preferences")
                                .font(.headline.weight(.semibold))

                            if model.isLiveReranking {
                                Text("Updated")
                                    .font(.caption.weight(.bold))
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 4)
                                    .background(AppPalette.accentBlue.opacity(0.12), in: Capsule())
                                    .foregroundStyle(AppPalette.accentBlue)
                            }

                            Spacer()

                            Image(systemName: showingResultsTastePanel ? "chevron.down" : "chevron.right")
                                .font(.caption.weight(.bold))
                        }
                        .foregroundStyle(AppPalette.ink)
                    }
                    .buttonStyle(.plain)

                    if showingResultsTastePanel {
                        VStack(alignment: .leading, spacing: 16) {
                            interactiveTasteScale(for: .body)
                            interactiveTasteScale(for: .tannin)
                            interactiveTasteScale(for: .sweetness)
                            interactiveTasteScale(for: .acidity)

                            Text(model.isLiveReranking
                                 ? "Results are re-ranked to match your updated preferences."
                                 : "Adjust sliders to instantly re-rank results without re-running analysis.")
                                .font(.footnote)
                                .foregroundStyle(AppPalette.muted)
                        }
                        .padding(18)
                        .background(AppPalette.cardSecondary, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    }
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text("Results")
                        .font(.system(size: 30, weight: .black, design: .serif))
                        .foregroundStyle(AppPalette.ink)

                    if let analysis, !analysis.recommendations.isEmpty {
                        resultControls(
                            inferredRecommendationCount: inferredRecommendationCount,
                            priceBounds: priceBounds,
                            effectiveMaxPrice: effectiveMaxPrice
                        )
                    }
                }

                if let analysisProgress, analysisProgress.status != .completed {
                    AnalysisProgressCard(
                        progress: analysisProgress,
                        canCancel: !(model.analysisState?.status.isTerminal ?? true),
                        isStopping: model.isStoppingAnalysis
                    ) {
                        Task {
                            await model.cancelCurrentAnalysis()
                        }
                    }
                }

                if isPriceFilterActive, let _ = priceBounds {
                    StatusNotice(
                        title: "Budget filter active",
                        message: "\(hiddenByPriceCount) wine\(hiddenByPriceCount == 1 ? "" : "s") hidden by the current budget settings.",
                        tint: AppPalette.accentBlue.opacity(0.10),
                        stroke: AppPalette.accentBlue.opacity(0.18)
                    )
                }

                if inferredRecommendationCount > 0 {
                    StatusNotice(
                        title: resultProfileFilter == .excludeInferred
                            ? "\(inferredRecommendationCount) inferred \(inferredRecommendationCount == 1 ? "profile hidden" : "profiles hidden")"
                            : "\(inferredRecommendationCount) \(inferredRecommendationCount == 1 ? "wine uses" : "wines use") estimated taste data",
                        message: resultProfileFilter == .excludeInferred
                            ? "These wines are excluded because Vivino did not return a reliable match."
                            : "When we cannot confirm a Vivino match, the app estimates the taste profile from the extracted wine details.",
                        tint: AppPalette.accentRed.opacity(0.08),
                        stroke: AppPalette.accentRed.opacity(0.16)
                    )
                }

                if hasStructuredResults {
                    sectionBrowser(
                        sections: resultSections,
                        totalCount: priceFiltered.count
                    )
                }

                if analysis == nil {
                    Text("No analysis yet.")
                        .font(.subheadline)
                        .foregroundStyle(AppPalette.muted)
                } else if analysis?.status == .processing && priceFiltered.isEmpty && !(analysis?.candidates.isEmpty ?? true) {
                    Text("Recommendations will appear here as each wine finishes processing.")
                        .font(.subheadline)
                        .foregroundStyle(AppPalette.muted)
                } else if analysis?.status == .canceled && priceFiltered.isEmpty {
                    Text("This run was stopped before any recommendations were saved.")
                        .font(.subheadline)
                        .foregroundStyle(AppPalette.muted)
                } else if analysis?.status == .completed && priceFiltered.isEmpty {
                    Text("No wines match the current result filters.")
                        .font(.subheadline)
                        .foregroundStyle(AppPalette.muted)
                }

                ForEach(visibleResultSections) { section in
                    VStack(alignment: .leading, spacing: 14) {
                        if hasStructuredResults {
                            HStack(alignment: .bottom) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Menu section")
                                        .font(.caption.weight(.bold))
                                        .textCase(.uppercase)
                                        .foregroundStyle(AppPalette.muted)
                                    Text(section.label)
                                        .font(.system(size: 22, weight: .heavy, design: .serif))
                                        .foregroundStyle(AppPalette.ink)
                                }

                                Spacer()

                                Text("\(section.recommendations.count) wine\(section.recommendations.count == 1 ? "" : "s")")
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(AppPalette.muted)
                            }
                        }

                        VStack(spacing: 16) {
                            ForEach(section.recommendations) { recommendation in
                                ResultCard(
                                    recommendation: recommendation,
                                    candidate: candidateById[recommendation.candidateId]
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    private func interactiveTasteScale(for dimension: TasteDimension) -> some View {
        TasteScaleRow(
            dimension: dimension,
            value: model.preferences[keyPath: dimension.keyPath],
            tone: .standard
        ) { nextValue in
            model.updatePreference(dimension.keyPath, value: nextValue)
        }
    }

    private func resultControls(
        inferredRecommendationCount: Int,
        priceBounds: PriceFilterBounds?,
        effectiveMaxPrice: Double?
    ) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            controlGroup(title: "Sort by") {
                HStack(spacing: 10) {
                    chipButton(
                        title: ResultSortOrder.recommended.label,
                        isSelected: resultSortOrder == .recommended
                    ) {
                        resultSortOrder = .recommended
                    }

                    chipButton(
                        title: ResultSortOrder.discovered.label,
                        isSelected: resultSortOrder == .discovered
                    ) {
                        resultSortOrder = .discovered
                    }
                }
            }

            if inferredRecommendationCount > 0 {
                controlGroup(title: "Taste data") {
                    HStack(spacing: 10) {
                        chipButton(
                            title: "All profiles",
                            isSelected: resultProfileFilter == .all
                        ) {
                            resultProfileFilter = .all
                        }

                        chipButton(
                            title: "Hide inferred",
                            isSelected: resultProfileFilter == .excludeInferred
                        ) {
                            resultProfileFilter = .excludeInferred
                        }
                    }
                }
            }

            if let priceBounds, let effectiveMaxPrice {
                controlGroup(title: "Budget") {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(alignment: .top) {
                            Text(effectiveMaxPrice < priceBounds.max
                                 ? "\(formatPriceValue(effectiveMaxPrice)) and under"
                                 : "Any price")
                                .font(.headline.weight(.semibold))

                            Spacer()

                            Text("\(formatPriceValue(priceBounds.min)) to \(formatPriceValue(priceBounds.max))")
                                .font(.footnote)
                                .foregroundStyle(AppPalette.muted)
                        }

                        Slider(
                            value: Binding(
                                get: { effectiveMaxPrice },
                                set: { maxPriceFilter = $0 }
                            ),
                            in: priceBounds.min...priceBounds.max,
                            step: 1
                        )
                        .tint(AppPalette.accentRed)

                        Toggle(
                            "Include wines without price\(priceBounds.missingCount > 0 ? " (\(priceBounds.missingCount))" : "")",
                            isOn: $includePriceUnavailable
                        )
                        .font(.footnote)
                        .tint(AppPalette.accentRed)
                    }
                    .padding(16)
                    .background(AppPalette.cardSecondary, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
            }
        }
    }

    private func sectionBrowser(sections: [ResultSection], totalCount: Int) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Browse by menu section")
                .font(.headline.weight(.semibold))
                .foregroundStyle(AppPalette.ink)

            Text("Jump between source tabs and sections without losing the current ranking.")
                .font(.footnote)
                .foregroundStyle(AppPalette.muted)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    chipButton(
                        title: "All sections",
                        subtitle: "\(totalCount)",
                        isSelected: selectedResultSectionId == allResultSectionsId
                    ) {
                        selectedResultSectionId = allResultSectionsId
                    }

                    ForEach(sections) { section in
                        chipButton(
                            title: section.label,
                            subtitle: "\(section.recommendations.count)",
                            isSelected: selectedResultSectionId == section.id
                        ) {
                            selectedResultSectionId = section.id
                        }
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }

    private func controlGroup<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.caption.weight(.bold))
                .textCase(.uppercase)
                .foregroundStyle(AppPalette.muted)

            content()
        }
    }

    private func chipButton(
        title: String,
        subtitle: String? = nil,
        isSelected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(title)
                    .lineLimit(1)

                if let subtitle {
                    Text(subtitle)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(isSelected ? Color.white.opacity(0.9) : AppPalette.muted)
                }
            }
            .font(.subheadline.weight(.semibold))
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(isSelected ? AppPalette.ink : AppPalette.cardSecondary, in: Capsule())
            .foregroundStyle(isSelected ? Color.white : AppPalette.ink)
            .overlay(
                Capsule()
                    .stroke(isSelected ? Color.clear : AppPalette.line, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
}

private struct ResultCard: View {
    let recommendation: Recommendation
    let candidate: WineCandidate?

    @State private var isDetailsExpanded = false

    private var isInferred: Bool {
        recommendation.profile?.taste.sourceMode == .inferred
    }

    private var menuTitle: String {
        candidate?.rawText ?? recommendation.profile?.displayName ?? "Unmatched wine"
    }

    private var matchedTitle: String? {
        guard let displayName = recommendation.profile?.displayName, displayName != menuTitle else {
            return nil
        }

        return displayName
    }

    private var menuContext: String? {
        formatMenuContext(menuTab: candidate?.menuTab, menuSection: candidate?.menuSection)
    }

    private var rating: Double? {
        recommendation.profile?.rating
    }

    private var ratingCount: Int? {
        recommendation.profile?.ratingCount
    }

    private var showRating: Bool {
        guard let rating, let ratingCount else { return false }
        return ratingCount > 0 && rating.isFinite
    }

    private var tastingNotesText: String {
        recommendation.profile?.tastingNotes?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private var tastingNoteGroups: [TastingNoteGroup] {
        recommendation.profile?.tastingNoteGroups ?? []
    }

    private var hasTastingNoteContent: Bool {
        !tastingNoteGroups.isEmpty || !tastingNotesText.isEmpty
    }

    private var showNoTastingNotesIndicator: Bool {
        recommendation.profile != nil && !isInferred && !hasTastingNoteContent
    }

    private var restaurantPrice: Double? {
        parsePrice(candidate?.price)
    }

    private var priceBenchmark: PriceBenchmark? {
        guard let restaurantPrice, let retailPrice = recommendation.profile?.retailPrice else {
            return nil
        }

        return computePriceBenchmark(restaurantPrice: restaurantPrice, retailPrice: retailPrice)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top, spacing: 16) {
                ResultImageView(imageURL: recommendation.profile?.imageUrl)

                VStack(alignment: .leading, spacing: 8) {
                    if let menuContext {
                        Text(menuContext)
                            .font(.caption.weight(.bold))
                            .textCase(.uppercase)
                            .foregroundStyle(AppPalette.muted)
                    }

                    Text(menuTitle)
                        .font(.system(size: 22, weight: .heavy, design: .serif))
                        .foregroundStyle(AppPalette.ink)

                    if let matchedTitle {
                        Text("Matched to \(matchedTitle)")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(AppPalette.muted)
                    }

                    Text(isInferred
                         ? "Estimated from menu data"
                         : recommendation.profile?.provenanceLabel ?? recommendation.status.label)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(isInferred ? AppPalette.accentRed : AppPalette.accentBlue)

                    if isInferred {
                        Text("No reliable Vivino match was found, so this taste profile is inferred from the extracted wine details.")
                            .font(.footnote)
                            .foregroundStyle(AppPalette.muted)
                    }

                    if showRating, let rating, let ratingCount {
                        VivinoRatingBlock(
                            rating: rating,
                            ratingCount: ratingCount,
                            ratingSource: recommendation.profile?.ratingSource
                        )
                    }
                }

                Spacer(minLength: 0)

                VStack(alignment: .trailing, spacing: 10) {
                    Text(candidate?.price ?? "Price unavailable")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(candidate?.price == nil ? AppPalette.muted : AppPalette.ink)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(AppPalette.cardSecondary, in: Capsule())

                    VStack(spacing: 4) {
                        Text("Fit")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(AppPalette.muted)
                        Text("\(Int(recommendation.fitScore.rounded()))")
                            .font(.title3.weight(.black))
                            .foregroundStyle(AppPalette.ink)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(AppPalette.accentRed.opacity(0.12), in: Capsule())
                }
            }

            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("What does this wine taste like?")
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(AppPalette.ink)
                    Spacer()
                    if isInferred {
                        Text("Estimated profile")
                            .font(.caption.weight(.bold))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(AppPalette.accentRed.opacity(0.10), in: Capsule())
                            .foregroundStyle(AppPalette.accentRed)
                    }
                }

                VStack(spacing: 12) {
                    ForEach(TasteDimension.allCases) { dimension in
                        TasteScaleRow(
                            dimension: dimension,
                            value: recommendation.profile?.taste[keyPath: dimension.tasteKeyPath],
                            tone: isInferred ? .uncertain : .standard
                        )
                    }
                }

                if let reviewCount = recommendation.profile?.tasteReviewCount, reviewCount > 0 {
                    Text("Based on \(formatCount(reviewCount)) user review\(reviewCount == 1 ? "" : "s")")
                        .font(.footnote)
                        .foregroundStyle(AppPalette.muted)
                }
            }
            .padding(16)
            .background(AppPalette.cardSecondary, in: RoundedRectangle(cornerRadius: 20, style: .continuous))

            DisclosureGroup(isExpanded: $isDetailsExpanded) {
                VStack(alignment: .leading, spacing: 16) {
                    if hasTastingNoteContent || showNoTastingNotesIndicator {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Tasting notes")
                                .font(.caption.weight(.bold))
                                .textCase(.uppercase)
                                .foregroundStyle(AppPalette.muted)

                            if showNoTastingNotesIndicator {
                                Text("No tasting notes reported.")
                                    .font(.subheadline)
                                    .foregroundStyle(AppPalette.muted)
                            } else if !tastingNoteGroups.isEmpty {
                                TastingNoteGroupSection(groups: tastingNoteGroups)
                            } else {
                                Text(tastingNotesText)
                                    .font(.subheadline)
                                    .foregroundStyle(AppPalette.ink)
                            }
                        }
                    }

                    if candidate?.price != nil || priceBenchmark != nil {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Price")
                                .font(.caption.weight(.bold))
                                .textCase(.uppercase)
                                .foregroundStyle(AppPalette.muted)

                            Text("\(candidate?.price ?? "Not listed") on the menu")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(AppPalette.ink)

                            if let priceBenchmark {
                                HStack(spacing: 8) {
                                    Text("~\(formatPriceValue(priceBenchmark.retailPrice)) avg retail")
                                    Text("-")
                                    Text("\(String(format: "%.1f", priceBenchmark.multiplier))x markup")
                                }
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(priceBenchmark.tint)
                            }
                        }
                    }

                    if candidate?.price == nil && priceBenchmark == nil && !hasTastingNoteContent && !showNoTastingNotesIndicator {
                        Text("No additional details available.")
                            .font(.subheadline)
                            .foregroundStyle(AppPalette.muted)
                    }
                }
                .padding(.top, 12)
            } label: {
                HStack {
                    Text("Tasting notes & details")
                        .font(.headline.weight(.semibold))
                    Spacer()
                }
                .foregroundStyle(AppPalette.ink)
            }
            .tint(AppPalette.ink)
        }
        .padding(18)
        .background(AppPalette.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(AppPalette.line, lineWidth: 1)
                .allowsHitTesting(false)
        )
        .shadow(color: .black.opacity(0.05), radius: 14, y: 8)
    }
}

private struct ResultImageView: View {
    let imageURL: String?

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [AppPalette.cardSecondary, AppPalette.background],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )

            if let imageURL, let url = URL(string: imageURL) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case let .success(image):
                        image
                            .resizable()
                            .scaledToFit()
                            .padding(12)
                    default:
                        Image(systemName: "wineglass.fill")
                            .font(.system(size: 28))
                            .foregroundStyle(AppPalette.accentBlue)
                    }
                }
            } else {
                Image(systemName: "wineglass.fill")
                    .font(.system(size: 28))
                    .foregroundStyle(AppPalette.accentBlue)
            }
        }
        .frame(width: 110, height: 140)
    }
}

private struct TastingNoteGroupSection: View {
    let groups: [TastingNoteGroup]

    var body: some View {
        VStack(spacing: 10) {
            ForEach(groups) { group in
                TastingNoteGroupCard(group: group)
            }
        }
    }
}

private struct TastingNoteGroupCard: View {
    let group: TastingNoteGroup

    private var visual: TastingNoteVisual {
        tastingNoteVisual(for: group.key)
    }

    private var cueImageURL: URL? {
        let preferred = group.imageUrl ?? group.keywordImageUrls.compactMap { $0 }.first
        guard let preferred else { return nil }
        return URL(string: preferred)
    }

    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(visual.surface)

                if let cueImageURL {
                    AsyncImage(url: cueImageURL) { phase in
                        switch phase {
                        case let .success(image):
                            image
                                .resizable()
                                .scaledToFill()
                        default:
                            Image(systemName: visual.symbol)
                                .font(.title3.weight(.bold))
                                .foregroundStyle(visual.accent)
                        }
                    }
                } else {
                    Image(systemName: visual.symbol)
                        .font(.title3.weight(.bold))
                        .foregroundStyle(visual.accent)
                }
            }
            .frame(width: 66, height: 66)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))

            VStack(alignment: .leading, spacing: 4) {
                Text(group.label)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(AppPalette.ink)
                Text(group.keywords.prefix(3).joined(separator: ", "))
                    .font(.subheadline)
                    .foregroundStyle(AppPalette.muted)
                Text("\(group.noteCount) note\(group.noteCount == 1 ? "" : "s")")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(visual.accent)
            }

            Spacer()
        }
        .padding(14)
        .background(visual.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
}

private struct VivinoRatingBlock: View {
    let rating: Double
    let ratingCount: Int
    let ratingSource: WineRatingSource?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Text(String(format: "%.1f", max(0, min(5, rating))))
                    .font(.headline.weight(.bold))
                    .foregroundStyle(AppPalette.ink)

                HStack(spacing: 2) {
                    ForEach(0..<5, id: \.self) { index in
                        Image(systemName: starSymbol(for: index))
                            .foregroundStyle(AppPalette.accentRed)
                            .font(.caption.weight(.bold))
                    }
                }
            }

            Text("\(formatCount(ratingCount)) rating\(ratingCount == 1 ? "" : "s")\(ratingSource == .wine ? " - all vintages" : "")")
                .font(.footnote)
                .foregroundStyle(AppPalette.muted)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(AppPalette.cardSecondary, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func starSymbol(for index: Int) -> String {
        let threshold = Double(index + 1)
        if rating >= threshold {
            return "star.fill"
        }

        if rating >= threshold - 0.5 {
            return "star.leadinghalf.filled"
        }

        return "star"
    }
}

private struct AnalysisProgressCard: View {
    let progress: AnalysisProgressState
    let canCancel: Bool
    let isStopping: Bool
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 14) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(progress.title)
                        .font(.caption.weight(.black))
                        .textCase(.uppercase)
                        .tracking(1.3)
                        .foregroundStyle(progress.tint)
                    Text(progress.detail)
                        .font(.subheadline)
                        .foregroundStyle(AppPalette.muted)
                }

                Spacer()

                Text(progress.countLabel)
                    .font(.headline.weight(.black))
                    .foregroundStyle(progress.tint)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(progress.tint.opacity(0.12), in: Capsule())
            }

            if let fraction = progress.fraction {
                ProgressView(value: fraction)
                    .tint(progress.tint)
            } else {
                ProgressView()
                    .tint(progress.tint)
            }

            if canCancel {
                Button(isStopping ? "Stopping..." : "Stop Analysis", action: onCancel)
                    .buttonStyle(OutlineActionButtonStyle())
                    .disabled(isStopping)
            }
        }
        .padding(18)
        .background(AppPalette.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(progress.tint.opacity(0.18), lineWidth: 1)
                .allowsHitTesting(false)
        )
    }
}

private struct URLPreviewCard: View {
    let preview: URLPreview
    let urlString: String

    private var host: String {
        URL(string: urlString)?.host ?? preview.domain
    }

    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(AppPalette.accentBlue.opacity(0.08))
                    .frame(width: 44, height: 44)

                Image(systemName: "safari.fill")
                    .foregroundStyle(AppPalette.accentBlue)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(preview.title ?? host)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(AppPalette.ink)
                    .lineLimit(2)
                Text(host)
                    .font(.footnote)
                    .foregroundStyle(AppPalette.muted)
            }

            Spacer()

            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(AppPalette.accentBlue)
                .font(.title3)
        }
        .padding(14)
        .background(AppPalette.accentBlue.opacity(0.04), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(AppPalette.accentBlue.opacity(0.16), lineWidth: 1)
                .allowsHitTesting(false)
        )
    }
}

private struct SelectedSourceCard: View {
    let title: String
    let subtitle: String
    let previewData: Data?
    let onRemove: () -> Void

    private var previewImage: UIImage? {
        guard let previewData else { return nil }
        return UIImage(data: previewData)
    }

    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(AppPalette.cardSecondary)

                if let previewImage {
                    Image(uiImage: previewImage)
                        .resizable()
                        .scaledToFill()
                } else {
                    Image(systemName: "doc.richtext.fill")
                        .foregroundStyle(AppPalette.accentBlue)
                        .font(.title2.weight(.bold))
                }
            }
            .frame(width: 78, height: 78)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(AppPalette.ink)
                    .lineLimit(2)
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(AppPalette.muted)
            }

            Spacer()

            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
                    .font(.title2)
                    .foregroundStyle(AppPalette.muted)
            }
            .buttonStyle(.plain)
        }
        .padding(16)
        .background(AppPalette.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(AppPalette.line, lineWidth: 1)
                .allowsHitTesting(false)
        )
    }
}

private struct StatusNotice: View {
    let title: String
    let message: String
    let tint: Color
    let stroke: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(AppPalette.ink)
            Text(message)
                .font(.footnote)
                .foregroundStyle(AppPalette.muted)
        }
        .padding(16)
        .background(tint, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(stroke, lineWidth: 1)
                .allowsHitTesting(false)
        )
    }
}

private struct SurfaceCard<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(22)
        .background(AppPalette.surface, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .stroke(AppPalette.line, lineWidth: 1)
                .allowsHitTesting(false)
        )
        .shadow(color: .black.opacity(0.06), radius: 18, y: 8)
    }
}

private struct DividerLabel: View {
    let text: String

    var body: some View {
        HStack(spacing: 14) {
            Rectangle()
                .fill(AppPalette.line)
                .frame(height: 1)
            Text(text)
                .font(.caption.weight(.bold))
                .tracking(1.8)
                .foregroundStyle(AppPalette.muted)
            Rectangle()
                .fill(AppPalette.line)
                .frame(height: 1)
        }
    }
}

private struct StoryImageBreakCard: View {
    let title: String
    let imageName: String
    let isLeading: Bool

    var body: some View {
        ZStack(alignment: isLeading ? .bottomLeading : .bottomTrailing) {
            Image(imageName)
                .resizable()
                .scaledToFill()
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            LinearGradient(
                colors: [
                    Color.black.opacity(0.12),
                    Color.black.opacity(0.22),
                    Color.black.opacity(0.55)
                ],
                startPoint: .top,
                endPoint: .bottom
            )

            Text(title)
                .font(.system(size: 34, weight: .black, design: .serif))
                .tracking(-1.2)
                .multilineTextAlignment(isLeading ? .leading : .trailing)
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, alignment: isLeading ? .leading : .trailing)
                .padding(.horizontal, 24)
                .padding(.bottom, 24)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 220)
        .clipped()
    }
}

private struct SourceChooserCard<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        VStack {
            content
        }
        .padding(18)
        .frame(maxWidth: .infinity)
        .background(Color.white.opacity(0.74), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(
                    AppPalette.line,
                    style: StrokeStyle(lineWidth: 1.4, dash: [6, 6])
                )
                .allowsHitTesting(false)
        )
    }
}

private struct AppBackground: View {
    var body: some View {
        ZStack {
            AppPalette.background
                .ignoresSafeArea()

            LinearGradient(
                colors: [
                    Color.white.opacity(0.34),
                    AppPalette.accentBlue.opacity(0.03),
                    AppPalette.background
                ],
                startPoint: .top,
                endPoint: .center
            )
            .ignoresSafeArea()

            LinearGradient(
                colors: [
                    .clear,
                    .clear,
                    AppPalette.accentRed.opacity(0.04)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()
        }
    }
}

private struct TasteScaleRow: View {
    let dimension: TasteDimension
    let value: Int?
    let tone: TasteScaleTone
    var onChange: ((Int) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(dimension.label)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppPalette.ink)
                Spacer()
                if let value {
                    Text("\(value)")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(tone == .uncertain ? AppPalette.muted : AppPalette.accentBlue)
                }
            }

            if let onChange {
                Slider(
                    value: Binding(
                        get: { Double(value ?? 3) },
                        set: { onChange(Int($0.rounded())) }
                    ),
                    in: 1...5,
                    step: 1
                )
                .tint(tone == .uncertain ? AppPalette.muted : AppPalette.accentBlue)
            } else {
                GeometryReader { geometry in
                    ZStack(alignment: .leading) {
                        Capsule()
                            .fill(tone == .uncertain ? AppPalette.trackMuted : AppPalette.track)
                            .frame(height: 8)

                        if let value {
                            Circle()
                                .fill(tone == .uncertain ? AppPalette.muted : AppPalette.accentBlue)
                                .frame(width: 18, height: 18)
                                .shadow(color: .black.opacity(0.12), radius: 6, y: 3)
                                .offset(x: tasteMarkerOffset(value: value, width: geometry.size.width))
                        }
                    }
                }
                .frame(height: 18)
            }

            HStack {
                Text(dimension.lowLabel)
                Spacer()
                Text(dimension.highLabel)
            }
            .font(.caption)
            .foregroundStyle(AppPalette.muted)
        }
    }
}

private struct PrimaryActionButtonStyle: ButtonStyle {
    var fullWidth = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .bold, design: .default))
            .foregroundStyle(.white)
            .frame(maxWidth: fullWidth ? .infinity : nil)
            .padding(.horizontal, 18)
            .padding(.vertical, 13)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(configuration.isPressed ? AppPalette.accentRed.opacity(0.84) : AppPalette.accentRed)
            )
            .shadow(color: AppPalette.accentRed.opacity(0.18), radius: configuration.isPressed ? 6 : 10, y: 4)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
}

private struct CompactPrimaryActionButtonStyle: ButtonStyle {
    var fullWidth = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 14, weight: .bold, design: .default))
            .foregroundStyle(.white)
            .frame(maxWidth: fullWidth ? .infinity : nil)
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(configuration.isPressed ? AppPalette.accentRed.opacity(0.84) : AppPalette.accentRed)
            )
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
}

private struct OutlineActionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 14, weight: .bold, design: .default))
            .foregroundStyle(AppPalette.accentBlue)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Color.white.opacity(0.92), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(AppPalette.line, lineWidth: 1)
            )
            .opacity(configuration.isPressed ? 0.84 : 1)
    }
}

private struct ResultSection: Identifiable {
    let id: String
    let label: String
    let menuTab: String?
    let menuSection: String?
    let recommendations: [Recommendation]
}

private struct PriceFilterBounds {
    let min: Double
    let max: Double
    let missingCount: Int
}

private struct AnalysisProgressState {
    let title: String
    let detail: String
    let processed: Int
    let total: Int
    let fraction: Double?
    let status: AnalysisStatus

    var tint: Color {
        switch status {
        case .failed:
            return AppPalette.accentRed
        case .canceled:
            return AppPalette.muted
        case .uploaded, .queued, .processing, .completed:
            return AppPalette.accentBlue
        }
    }

    var countLabel: String {
        if total > 0 {
            return "\(processed)/\(total)"
        }

        switch status {
        case .canceled:
            return "Stopped"
        case .failed:
            return "Failed"
        case .uploaded, .queued, .processing, .completed:
            return "OCR"
        }
    }
}

private struct PriceBenchmark {
    let retailPrice: Double
    let multiplier: Double
    let tier: PriceBenchmarkTier

    var tint: Color {
        switch tier {
        case .fair:
            return Color(red: 0.17, green: 0.47, blue: 0.30)
        case .average:
            return Color(red: 0.68, green: 0.45, blue: 0.14)
        case .steep:
            return AppPalette.accentRed
        }
    }
}

private enum PriceBenchmarkTier {
    case fair
    case average
    case steep
}

private enum ResultSortOrder: CaseIterable, Identifiable, Equatable {
    case recommended
    case discovered

    var id: Self { self }

    var label: String {
        switch self {
        case .recommended:
            return "Most recommended"
        case .discovered:
            return "Image order"
        }
    }
}

private enum ResultProfileFilter: Equatable {
    case all
    case excludeInferred
}

private enum TasteScaleTone {
    case standard
    case uncertain
}

private enum TasteDimension: CaseIterable, Identifiable {
    case body
    case tannin
    case sweetness
    case acidity

    var id: Self { self }

    var label: String {
        switch self {
        case .body:
            return "Body"
        case .tannin:
            return "Tannin"
        case .sweetness:
            return "Sweetness"
        case .acidity:
            return "Acidity"
        }
    }

    var lowLabel: String {
        switch self {
        case .body:
            return "Light"
        case .tannin:
            return "Smooth"
        case .sweetness:
            return "Dry"
        case .acidity:
            return "Soft"
        }
    }

    var highLabel: String {
        switch self {
        case .body:
            return "Bold"
        case .tannin:
            return "Tannic"
        case .sweetness:
            return "Sweet"
        case .acidity:
            return "Acidic"
        }
    }

    var keyPath: WritableKeyPath<UserTastePreference, Int> {
        switch self {
        case .body:
            return \.body
        case .tannin:
            return \.tannin
        case .sweetness:
            return \.sweetness
        case .acidity:
            return \.acidity
        }
    }

    var tasteKeyPath: KeyPath<TasteVector, Int> {
        switch self {
        case .body:
            return \.body
        case .tannin:
            return \.tannin
        case .sweetness:
            return \.sweetness
        case .acidity:
            return \.acidity
        }
    }
}

private struct TastingNoteVisual {
    let accent: Color
    let surface: Color
    let symbol: String
}

private enum AppPalette {
    static let background = Color(red: 1.0, green: 0.98, blue: 0.945)
    static let surface = Color.white.opacity(0.92)
    static let cardSecondary = Color(red: 0.97, green: 0.96, blue: 0.94)
    static let ink = Color(red: 0.10, green: 0.10, blue: 0.10)
    static let muted = Color(red: 0.43, green: 0.43, blue: 0.43)
    static let accentBlue = Color(red: 0.047, green: 0.412, blue: 0.604)
    static let accentRed = Color(red: 0.780, green: 0.212, blue: 0.122)
    static let line = accentBlue.opacity(0.12)
    static let track = Color(red: 0.88, green: 0.87, blue: 0.85)
    static let trackMuted = Color(red: 0.84, green: 0.82, blue: 0.80)
}

private func rerankedRecommendations(
    analysis: AnalysisRun?,
    preferences: UserTastePreference,
    useLiveReranking: Bool
) -> [Recommendation] {
    guard let analysis else {
        return []
    }

    guard useLiveReranking else {
        return analysis.recommendations
    }

    return analysis.recommendations
        .map { recommendation in
            Recommendation(
                candidateId: recommendation.candidateId,
                fitScore: recommendation.profile.map { scoreRecommendation(preference: preferences, taste: $0.taste) } ?? recommendation.fitScore,
                matchConfidence: recommendation.matchConfidence,
                profile: recommendation.profile,
                status: recommendation.status
            )
        }
        .sorted {
            if $0.fitScore == $1.fitScore {
                return $0.matchConfidence > $1.matchConfidence
            }

            return $0.fitScore > $1.fitScore
        }
}

private func scoreRecommendation(preference: UserTastePreference, taste: TasteVector) -> Double {
    let weightedDistance =
        abs(Double(preference.body - taste.body)) * preference.weights.body +
        abs(Double(preference.acidity - taste.acidity)) * preference.weights.acidity +
        abs(Double(preference.tannin - taste.tannin)) * preference.weights.tannin +
        abs(Double(preference.sweetness - taste.sweetness)) * preference.weights.sweetness
    let maxDistance =
        4 * preference.weights.body +
        4 * preference.weights.acidity +
        4 * preference.weights.tannin +
        4 * preference.weights.sweetness

    guard maxDistance > 0 else {
        return 100
    }

    return max(0, min(100, round((1 - weightedDistance / maxDistance) * 100)))
}

private func sortRecommendations(
    recommendations: [Recommendation],
    candidates: [WineCandidate],
    sortOrder: ResultSortOrder
) -> [Recommendation] {
    guard sortOrder == .discovered else {
        return recommendations
    }

    let discoveredOrder = Dictionary(uniqueKeysWithValues: candidates.enumerated().map { ($1.id, $0) })
    let rankedOrder = Dictionary(uniqueKeysWithValues: recommendations.enumerated().map { ($1.candidateId, $0) })

    return recommendations.sorted { left, right in
        let leftDiscovered = discoveredOrder[left.candidateId] ?? .max
        let rightDiscovered = discoveredOrder[right.candidateId] ?? .max

        if leftDiscovered != rightDiscovered {
            return leftDiscovered < rightDiscovered
        }

        return (rankedOrder[left.candidateId] ?? .max) < (rankedOrder[right.candidateId] ?? .max)
    }
}

private func isInferredRecommendation(_ recommendation: Recommendation) -> Bool {
    recommendation.profile?.taste.sourceMode == .inferred
}

private func filterRecommendationsByProfileSource(
    recommendations: [Recommendation],
    filter: ResultProfileFilter
) -> [Recommendation] {
    guard filter == .excludeInferred else {
        return recommendations
    }

    return recommendations.filter { !isInferredRecommendation($0) }
}

private func filterRecommendationsByPrice(
    recommendations: [Recommendation],
    candidateById: [String: WineCandidate],
    maxPrice: Double?,
    includeUnavailable: Bool
) -> [Recommendation] {
    recommendations.filter { recommendation in
        let parsedPrice = parsePrice(candidateById[recommendation.candidateId]?.price)

        guard let maxPrice else {
            return includeUnavailable || parsedPrice != nil
        }

        guard let parsedPrice else {
            return includeUnavailable
        }

        return parsedPrice <= maxPrice
    }
}

private func getPriceFilterBounds(candidates: [WineCandidate]) -> PriceFilterBounds? {
    let parsedPrices = candidates.compactMap { parsePrice($0.price) }
    guard !parsedPrices.isEmpty else {
        return nil
    }

    return PriceFilterBounds(
        min: max(0, floor(parsedPrices.min() ?? 0)),
        max: ceil(parsedPrices.max() ?? 0),
        missingCount: candidates.count - parsedPrices.count
    )
}

private func isBudgetFilterActive(
    bounds: PriceFilterBounds?,
    effectiveMaxPrice: Double?,
    includeUnavailable: Bool
) -> Bool {
    guard let bounds, let effectiveMaxPrice else {
        return false
    }

    return effectiveMaxPrice < bounds.max || (!includeUnavailable && bounds.missingCount > 0)
}

private func buildResultSections(
    analysis: AnalysisRun?,
    recommendations: [Recommendation],
    candidateById: [String: WineCandidate]
) -> [ResultSection] {
    guard let analysis, !recommendations.isEmpty else {
        return []
    }

    var sectionOrder: [String: Int] = [:]
    for (index, candidate) in analysis.candidates.enumerated() {
        let id = resultSectionId(menuTab: candidate.menuTab, menuSection: candidate.menuSection)
        if sectionOrder[id] == nil {
            sectionOrder[id] = index
        }
    }

    var sectionsByID: [String: ResultSection] = [:]

    for recommendation in recommendations {
        let candidate = candidateById[recommendation.candidateId]
        let id = resultSectionId(menuTab: candidate?.menuTab, menuSection: candidate?.menuSection)
        if var existing = sectionsByID[id] {
            existing = ResultSection(
                id: existing.id,
                label: existing.label,
                menuTab: existing.menuTab,
                menuSection: existing.menuSection,
                recommendations: existing.recommendations + [recommendation]
            )
            sectionsByID[id] = existing
        } else {
            sectionsByID[id] = ResultSection(
                id: id,
                label: formatMenuContext(menuTab: candidate?.menuTab, menuSection: candidate?.menuSection) ?? "Unlabeled results",
                menuTab: candidate?.menuTab,
                menuSection: candidate?.menuSection,
                recommendations: [recommendation]
            )
        }
    }

    return sectionsByID.values.sorted {
        (sectionOrder[$0.id] ?? .max) < (sectionOrder[$1.id] ?? .max)
    }
}

private func resolvedVisibleSections(
    allSections: [ResultSection],
    selectedResultSectionId: String
) -> [ResultSection] {
    guard selectedResultSectionId != allResultSectionsId else {
        return allSections
    }

    let filtered = allSections.filter { $0.id == selectedResultSectionId }
    return filtered.isEmpty ? allSections : filtered
}

private func resultSectionId(menuTab: String?, menuSection: String?) -> String {
    "\(menuTab ?? ""):::\(menuSection ?? "")"
}

private func formatMenuContext(menuTab: String?, menuSection: String?) -> String? {
    let segments = [menuTab, menuSection].compactMap { $0 }.filter { !$0.isEmpty }
    return segments.isEmpty ? nil : segments.joined(separator: " - ")
}

private func getAnalysisProgress(analysis: AnalysisRun?) -> AnalysisProgressState? {
    guard let analysis else {
        return nil
    }

    if analysis.status == .uploaded || analysis.status == .queued {
        return AnalysisProgressState(
            title: "Queued for processing",
            detail: "Waiting for the worker to start OCR and parse the wine list.",
            processed: 0,
            total: 0,
            fraction: nil,
            status: analysis.status
        )
    }

    let total = analysis.candidates.count
    let processed = min(analysis.recommendations.count, total)

    if analysis.status == .processing {
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
                : "Progress updates automatically as each wine finishes processing.",
            processed: processed,
            total: total,
            fraction: total > 0 ? Double(processed) / Double(total) : nil,
            status: analysis.status
        )
    }

    if analysis.status == .failed {
        return AnalysisProgressState(
            title: "Analysis failed",
            detail: analysis.errorMessage ?? "The worker stopped before finishing the wine list.",
            processed: processed,
            total: total,
            fraction: total > 0 ? Double(processed) / Double(total) : nil,
            status: analysis.status
        )
    }

    if analysis.status == .canceled {
        return AnalysisProgressState(
            title: total > 0 ? "Analysis stopped at \(processed) of \(total) wines" : "Analysis stopped",
            detail: total > 0
                ? "This run was stopped. Any recommendations shown below are partial results."
                : "This run was stopped before OCR and matching finished.",
            processed: processed,
            total: total,
            fraction: total > 0 ? Double(processed) / Double(total) : nil,
            status: analysis.status
        )
    }

    return nil
}

private func parsePrice(_ rawPrice: String?) -> Double? {
    guard let rawPrice else {
        return nil
    }

    let pattern = #"\d+(?:\.\d{1,2})?"#
    guard let range = rawPrice.range(of: pattern, options: .regularExpression) else {
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

private func computePriceBenchmark(restaurantPrice: Double, retailPrice: Double) -> PriceBenchmark? {
    guard restaurantPrice > 0, retailPrice > 0 else {
        return nil
    }

    let multiplier = restaurantPrice / retailPrice
    let tier: PriceBenchmarkTier

    if multiplier <= 2.5 {
        tier = .fair
    } else if multiplier <= 3.5 {
        tier = .average
    } else {
        tier = .steep
    }

    return PriceBenchmark(
        retailPrice: retailPrice,
        multiplier: multiplier,
        tier: tier
    )
}

private func formatCount(_ count: Int) -> String {
    let formatter = NumberFormatter()
    formatter.numberStyle = .decimal
    return formatter.string(from: NSNumber(value: count)) ?? "\(count)"
}

private func tasteMarkerOffset(value: Int, width: CGFloat) -> CGFloat {
    let normalized = CGFloat(max(1, min(5, value)) - 1) / 4
    let available = max(0, width - 18)
    return normalized * available
}

private func tastingNoteVisual(for key: String) -> TastingNoteVisual {
    let normalized = key.lowercased()

    if normalized.contains("red-fruit") || normalized.contains("berry") {
        return TastingNoteVisual(
            accent: Color(red: 0.79, green: 0.23, blue: 0.20),
            surface: Color(red: 0.79, green: 0.23, blue: 0.20).opacity(0.12),
            symbol: "circle.hexagongrid.fill"
        )
    }

    if normalized.contains("black-fruit") {
        return TastingNoteVisual(
            accent: Color(red: 0.20, green: 0.26, blue: 0.55),
            surface: Color(red: 0.20, green: 0.26, blue: 0.55).opacity(0.12),
            symbol: "moon.stars.fill"
        )
    }

    if normalized.contains("citrus") || normalized.contains("tropical") {
        return TastingNoteVisual(
            accent: Color(red: 0.84, green: 0.62, blue: 0.20),
            surface: Color(red: 0.84, green: 0.62, blue: 0.20).opacity(0.14),
            symbol: "sun.max.fill"
        )
    }

    if normalized.contains("floral") || normalized.contains("flower") {
        return TastingNoteVisual(
            accent: Color(red: 0.71, green: 0.38, blue: 0.52),
            surface: Color(red: 0.71, green: 0.38, blue: 0.52).opacity(0.14),
            symbol: "sparkles"
        )
    }

    if normalized.contains("oak") || normalized.contains("spice") {
        return TastingNoteVisual(
            accent: Color(red: 0.58, green: 0.38, blue: 0.22),
            surface: Color(red: 0.58, green: 0.38, blue: 0.22).opacity(0.14),
            symbol: "barrel.fill"
        )
    }

    return TastingNoteVisual(
        accent: Color(red: 0.44, green: 0.36, blue: 0.28),
        surface: Color(red: 0.44, green: 0.36, blue: 0.28).opacity(0.12),
        symbol: "leaf.fill"
    )
}
