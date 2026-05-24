import PhotosUI
import SwiftUI
import UIKit

private let allResultSectionsId = "__all_sections__"
private enum AppArtwork {
    static let hero = "HeroBackground"
    static let bottlesBreak = "StoryBottles"
    static let shelfBreak = "StoryShelf"
}

private enum AppLayout {
    static let navHeight: CGFloat = 56
    static let horizontalInset: CGFloat = 16
    static let resultsHorizontalInset: CGFloat = 16
    static let mobileContentWidth: CGFloat = 640
    static let panelRadius: CGFloat = 20
    static let controlRadius: CGFloat = 8
}

struct ContentView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @State private var showingImporter = false
    @State private var showingCamera = false
    @State private var showingPhotoPicker = false
    @State private var showingSourceOptions = false
    @State private var showingTastePanel = false
    @State private var showingResultsTastePanel = false
    @State private var resultFiltersOpen = false
    @State private var sectionBrowserOpen = false
    @State private var resultSortOrder = ResultSortOrder.recommended
    @State private var resultProfileFilter = ResultProfileFilter.excludeInferred
    @State private var selectedResultSectionId = allResultSectionsId
    @State private var activePageSection = 0
    @State private var maxPriceFilter: Double?
    @State private var includePriceUnavailable = true

    private var heroHeight: CGFloat {
        UIScreen.main.bounds.height
    }

    private var shouldStackPrimaryControls: Bool {
        horizontalSizeClass == .compact && UIScreen.main.bounds.width < 430
    }

    private var ingestTopPadding: CGFloat {
        48
    }

    private var ingestBottomPadding: CGFloat {
        28
    }

    private var resultsTopPadding: CGFloat {
        48
    }

    private var resultsBottomPadding: CGFloat {
        32
    }

    private var uiTestFixtureImagePath: String? {
        guard ProcessInfo.processInfo.arguments.contains("-ui-testing-reset-state") else {
            return nil
        }

        return ProcessInfo.processInfo.environment["WINE_REC_UI_TEST_FIXTURE_IMAGE_PATH"]
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
                            VStack(spacing: 0) {
                                heroSection(proxy: proxy)
                                    .id("hero")

                                ingestSection
                                    .id("ingest")

                                StoryImageBreakCard(
                                    title: "EVERY LIST.\nEVERY BOTTLE.\nRANKED FOR YOU.",
                                    imageName: AppArtwork.bottlesBreak,
                                    isLeading: true
                                )

                                resultsSection(width: max(0, geometry.size.width - (AppLayout.resultsHorizontalInset * 2)))
                                    .padding(.top, resultsTopPadding)
                                    .padding(.bottom, resultsBottomPadding)
                                    .id("results")

                                StoryImageBreakCard(
                                    title: "CURATED BY DATA.\nCHOSEN BY TASTE.",
                                    imageName: AppArtwork.shelfBreak,
                                    isLeading: true,
                                    minimumHeight: max(530, UIScreen.main.bounds.height * 0.63)
                                )
                            }
                            .frame(width: geometry.size.width, alignment: .top)
                            .padding(.bottom, 40)
                        }

                        topBar(proxy: proxy)

                        if showingTastePanel {
                            tasteDrawer
                                .padding(.top, AppLayout.navHeight)
                                .transition(.opacity)
                        }
                    }
                    .ignoresSafeArea(.container, edges: .top)
                }
                .toolbar(.hidden, for: .navigationBar)
                .statusBarHidden(true)
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
                .sheet(isPresented: $showingCamera) {
                    CameraCaptureView { image in
                        Task {
                            await model.importCapturedImage(image)
                        }
                    }
                    .ignoresSafeArea()
                }
                .sheet(isPresented: $showingPhotoPicker) {
                    PhotoLibraryPickerView { data in
                        Task {
                            await model.importImageData(data, filename: "Selected photo.jpg")
                        }
                    }
                }
                .confirmationDialog("Import a wine list", isPresented: $showingSourceOptions, titleVisibility: .visible) {
                    Button("Camera") {
                        if UIImagePickerController.isSourceTypeAvailable(.camera) {
                            showingCamera = true
                        } else {
                            showingPhotoPicker = true
                        }
                    }
                    .accessibilityIdentifier("camera-button")

                    Button("Photos") {
                        showingPhotoPicker = true
                    }
                    .accessibilityIdentifier("photos-button")

                    Button("Files") {
                        showingImporter = true
                    }
                    .accessibilityIdentifier("files-button")
                }
                .onChange(of: model.analysis?.id) { _, _ in
                    maxPriceFilter = nil
                    includePriceUnavailable = true
                    selectedResultSectionId = allResultSectionsId
                    resultFiltersOpen = false
                    sectionBrowserOpen = false
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

    private func topBar(proxy: ScrollViewProxy) -> some View {
        HStack(spacing: 14) {
            SectionNavigationDots(activeIndex: activePageSection) { index in
                let sectionID = ["hero", "ingest", "results"][index]
                activePageSection = index

                withAnimation(.spring(response: 0.52, dampingFraction: 0.9)) {
                    proxy.scrollTo(sectionID, anchor: .top)
                }
            }

            Text("Wine Rec")
                .font(AppTypography.display(size: 21))
                .tracking(-0.63)
                .foregroundStyle(AppPalette.ink)

            Spacer()

            Button(showingTastePanel ? "Close" : "My Taste") {
                withAnimation(.easeInOut(duration: 0.12)) {
                    showingTastePanel.toggle()
                }
            }
            .accessibilityIdentifier("top-my-taste-button")
            .buttonStyle(NavToggleButtonStyle())
        }
        .padding(.horizontal, AppLayout.horizontalInset)
        .frame(maxWidth: .infinity)
        .frame(height: AppLayout.navHeight)
        .background(AppPalette.background.opacity(0.85))
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(AppPalette.line)
                .frame(height: 1)
                .allowsHitTesting(false)
        }
    }

    private var tasteDrawer: some View {
        VStack(alignment: .leading, spacing: 10) {
                Text("How should your wine taste?")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(AppPalette.ink)

                VStack(spacing: 0) {
                    interactiveTasteScale(for: .body)
                    interactiveTasteScale(for: .tannin)
                    interactiveTasteScale(for: .sweetness)
                    interactiveTasteScale(for: .acidity)
                }

                Text("Adjust your preferences to automatically re-rank wines.")
                    .font(.footnote)
                    .foregroundStyle(AppPalette.muted)
            }
            .frame(maxWidth: AppLayout.mobileContentWidth, alignment: .leading)
            .padding(.horizontal, AppLayout.horizontalInset)
            .padding(.top, 16)
            .padding(.bottom, 17)
            .frame(maxWidth: .infinity)
            .background(AppPalette.background.opacity(0.96))
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(AppPalette.line)
                    .frame(height: 1)
            }
            .shadow(color: .black.opacity(0.08), radius: 18, y: 10)
    }

    private func heroSection(proxy: ScrollViewProxy) -> some View {
        GeometryReader { geometry in
            let horizontalInset = AppLayout.horizontalInset
            let copyWidth = max(geometry.size.width - (horizontalInset * 2), 0)
            let titleSize: CGFloat = geometry.size.width < 360 ? 46 : 50

            ZStack(alignment: .bottomLeading) {
                Image(AppArtwork.hero)
                    .resizable()
                    .scaledToFill()
                    .frame(width: geometry.size.width, height: geometry.size.height)
                    .overlay {
                        LinearGradient(
                            colors: [
                                Color.black.opacity(0.02),
                                Color.black.opacity(0.15),
                                Color.black.opacity(0.58)
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    }

                LinearGradient(
                    colors: [Color.black.opacity(0.14), .clear],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: 140)
                .frame(maxHeight: .infinity, alignment: .top)

                VStack(alignment: .leading, spacing: 0) {
                    Text("WINE REC")
                        .font(AppTypography.display(size: titleSize))
                        .foregroundStyle(.white)
                        .tracking(-1.5)
                        .lineLimit(1)
                        .minimumScaleFactor(0.74)
                        .multilineTextAlignment(.leading)

                    Text("Find the best bottle on any wine list.")
                        .font(AppTypography.body(size: 19))
                        .foregroundStyle(Color.white.opacity(0.88))
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 20)

                    Button("Get Started") {
                        withAnimation(.spring(response: 0.5, dampingFraction: 0.9)) {
                            proxy.scrollTo("ingest", anchor: .top)
                        }
                    }
                    .accessibilityIdentifier("get-started-button")
                    .buttonStyle(PrimaryActionButtonStyle())
                    .padding(.top, 28)
                }
                .frame(width: copyWidth, alignment: .leading)
                .padding(.leading, horizontalInset)
                .padding(.bottom, 16)
            }
            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .bottomLeading)
            .clipped()
        }
        .frame(height: heroHeight)
    }

    private var ingestSection: some View {
        VStack(spacing: 0) {
            VStack(alignment: .center, spacing: 14) {
                OnboardingDots(currentStep: model.hasPendingSource ? 2 : 1)

                if model.hasPendingSource {
                    preferenceStep
                } else {
                    sourceStep
                }

                if let errorMessage = model.errorMessage {
                    StatusNotice(
                        title: "Something needs attention",
                        message: errorMessage,
                        tint: AppPalette.accentRed.opacity(0.16),
                        stroke: AppPalette.accentRed.opacity(0.24)
                    )
                }
            }
            .frame(maxWidth: AppLayout.mobileContentWidth)
            .padding(.horizontal, AppLayout.horizontalInset)
            .padding(.top, ingestTopPadding)
            .padding(.bottom, ingestBottomPadding)
            .frame(maxWidth: .infinity)
        }
        .background(AppPalette.background)
    }

    private var sourceStep: some View {
        VStack(alignment: .center, spacing: 16) {
            VStack(spacing: 8) {
                Text("What's on the list?")
                    .font(AppTypography.display(size: 30))
                    .tracking(-0.6)
                    .foregroundStyle(AppPalette.ink)
                    .multilineTextAlignment(.center)
                Text("Paste a link or snap a photo of any wine list.")
                    .font(AppTypography.body(size: 18))
                    .foregroundStyle(AppPalette.muted)
                    .multilineTextAlignment(.center)
            }

            if let providerHealthNotice = model.providerHealthNotice {
                StatusNotice(
                    title: "Provider status",
                    message: providerHealthNotice,
                    tint: AppPalette.accentBlue.opacity(0.08),
                    stroke: AppPalette.accentBlue.opacity(0.16)
                )
            }

            urlTextField
                .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(AppPalette.line, lineWidth: 1.5)
                        .allowsHitTesting(false)
                )

            if let urlPreview = model.urlPreview {
                URLPreviewCard(preview: urlPreview, urlString: model.pendingURL ?? model.sourceURLText)
            }

            DividerLabel(text: "OR")

            SourceDropZone(isReading: model.isRunningVisionOCR) {
                showingSourceOptions = true
            }

            if let uiTestFixtureImagePath {
                Button("Import test image") {
                    Task {
                        let url = URL(fileURLWithPath: uiTestFixtureImagePath)
                        let data = UIImage(named: AppArtwork.shelfBreak)?.jpegData(compressionQuality: 0.9)
                            ?? (try? Data(contentsOf: url))
                        if let data {
                            await model.importImageData(data, filename: "Selected photo.jpg")
                        }
                    }
                }
                .accessibilityIdentifier("ui-test-import-image-button")
                .font(.caption2)
                .frame(width: 120, height: 44)
            }

            HStack {
                Spacer()
                nextButton(fullWidth: false)
            }
            .padding(.top, 2)
        }
        .task(id: uiTestFixtureImagePath) {
            guard let uiTestFixtureImagePath, !model.hasPendingSource else {
                return
            }

            await importUITestFixtureImage(from: uiTestFixtureImagePath)
        }
    }

    private func importUITestFixtureImage(from path: String) async {
        let url = URL(fileURLWithPath: path)
        let data = UIImage(named: AppArtwork.shelfBreak)?.jpegData(compressionQuality: 0.9)
            ?? (try? Data(contentsOf: url))
        guard let data else {
            return
        }

        model.importUITestFixtureImageData(data, filename: "Selected photo.jpg")
    }

    private var preferenceStep: some View {
        VStack(alignment: .center, spacing: 24) {
            VStack(spacing: 10) {
                Text("Confirm your preferences")
                    .font(AppTypography.display(size: 30))
                    .tracking(-0.6)
                    .foregroundStyle(AppPalette.ink)
                    .multilineTextAlignment(.center)
                    .minimumScaleFactor(0.82)
                Text("Adjust if you'd like, then analyze.")
                    .font(AppTypography.body(size: 18))
                    .foregroundStyle(AppPalette.muted)
                    .multilineTextAlignment(.center)
            }

            if model.selectedFileURL != nil {
                SelectedSourceCard(
                    title: model.selectedFileName ?? "Selected file",
                    subtitle: "",
                    previewData: model.selectedFilePreviewData
                ) {
                    model.clearSelectedFile()
                }
            } else if let urlPreview = model.urlPreview {
                URLPreviewCard(preview: urlPreview, urlString: model.pendingURL ?? model.sourceURLText)
            }

            VStack(spacing: 0) {
                interactiveTasteScale(for: .body)
                interactiveTasteScale(for: .tannin)
                interactiveTasteScale(for: .sweetness)
                interactiveTasteScale(for: .acidity)
            }

            HStack {
                Button {
                    model.clearSelectedFile()
                    model.clearPendingURL()
                } label: {
                    Label("Back", systemImage: "arrow.left")
                        .labelStyle(.titleAndIcon)
                }
                .font(AppTypography.body(size: 17, weight: .medium))
                .foregroundStyle(AppPalette.muted)
                .buttonStyle(.plain)

                Spacer()

                Button(model.isBusy ? "Starting..." : "Analyze →") {
                    Task {
                        await model.analyzePendingSource()
                    }
                }
                .accessibilityIdentifier("analyze-button")
                .buttonStyle(PrimaryActionButtonStyle(fullWidth: false))
                .disabled(model.isBusy)
            }
            .padding(.top, 4)
        }
    }

    private var urlInputControls: some View {
        Group {
            if shouldStackPrimaryControls {
                VStack(spacing: 10) {
                    urlTextField
                    nextButton(fullWidth: true)
                }
            } else {
                HStack(spacing: 10) {
                    urlTextField
                    nextButton(fullWidth: false)
                }
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
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("wine-list-url-field")
    }

    private func nextButton(fullWidth: Bool) -> some View {
        Button(model.isBusy ? "Loading..." : "Next →", action: confirmPendingURL)
            .accessibilityIdentifier("url-next-button")
            .buttonStyle(CompactPrimaryActionButtonStyle(fullWidth: fullWidth))
            .disabled(model.isBusy)
    }

    private var sourceSelectionControls: some View {
        Group {
            if shouldStackPrimaryControls {
                VStack(spacing: 12) {
                    cameraButton
                    photoPickerButton
                    filePickerButton
                }
            } else {
                HStack(spacing: 12) {
                    cameraButton
                    photoPickerButton
                    filePickerButton
                }
            }
        }
    }

    private var cameraButton: some View {
        Button {
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                showingCamera = true
            } else {
                showingPhotoPicker = true
            }
        } label: {
            Label("Camera", systemImage: "camera")
                .frame(maxWidth: .infinity)
        }
        .accessibilityIdentifier("camera-button")
        .buttonStyle(OutlineActionButtonStyle())
        .disabled(model.isBusy)
    }

    private var photoPickerButton: some View {
        Button {
            showingPhotoPicker = true
        } label: {
            Label("Photos", systemImage: "photo")
                .frame(maxWidth: .infinity)
        }
        .accessibilityIdentifier("photos-button")
        .buttonStyle(OutlineActionButtonStyle())
        .disabled(model.isBusy)
    }

    private var filePickerButton: some View {
        Button {
            showingImporter = true
        } label: {
            Label("Files", systemImage: "doc.badge.plus")
                .frame(maxWidth: .infinity)
        }
        .accessibilityIdentifier("files-button")
        .buttonStyle(OutlineActionButtonStyle())
        .disabled(model.isBusy)
    }

    private func resultsSection(width: CGFloat) -> some View {
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

        return SurfaceCard(width: width) {
            VStack(alignment: .leading, spacing: 18) {
                if analysis != nil {
                    HStack(spacing: 10) {
                        Button("Adjust Preferences") {
                            withAnimation(.spring(response: 0.3, dampingFraction: 0.84)) {
                                showingResultsTastePanel.toggle()
                            }
                        }
                        .buttonStyle(ResultsActionButtonStyle(minWidth: 122))

                        Spacer(minLength: 14)

                        if model.hasActiveAnalysis {
                            Button(model.isBusy ? "Stopping..." : "Stop Analysis") {
                                Task {
                                    await model.cancelCurrentAnalysis()
                                }
                            }
                            .accessibilityIdentifier("stop-analysis-button")
                            .buttonStyle(ResultsActionButtonStyle(minWidth: 106))
                            .disabled(model.isBusy)
                        }
                    }
                    .frame(maxWidth: .infinity)

                    if showingResultsTastePanel {
                        VStack(alignment: .leading, spacing: 9) {
                            VStack(spacing: 0) {
                                interactiveTasteScale(for: .body)
                                interactiveTasteScale(for: .tannin)
                                interactiveTasteScale(for: .sweetness)
                                interactiveTasteScale(for: .acidity)
                            }

                            Text(model.isLiveReranking
                                 ? "Results are re-ranked to match your updated preferences."
                                 : "Adjust sliders to instantly re-rank results without re-running analysis.")
                                .font(.footnote)
                                .foregroundStyle(AppPalette.muted)
                        }
                        .padding(14)
                        .background(AppPalette.cardSecondary, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    }
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text("Results")
                        .font(AppTypography.display(size: 30))
                        .tracking(-0.6)
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
                        isActive: model.hasActiveAnalysis,
                        isBusy: model.isBusy,
                        pollingPaused: model.pollingPaused,
                        pollingStatusMessage: model.pollingStatusMessage,
                        onCancel: {
                            Task {
                                await model.cancelCurrentAnalysis()
                            }
                        },
                        onResume: {
                            model.resumePolling()
                        }
                    )
                }

                if resultFiltersOpen, isPriceFilterActive, let _ = priceBounds {
                    StatusNotice(
                        title: "Budget filter active",
                        message: "\(hiddenByPriceCount) wine\(hiddenByPriceCount == 1 ? "" : "s") hidden by the current budget settings.",
                        tint: AppPalette.accentBlue.opacity(0.10),
                        stroke: AppPalette.accentBlue.opacity(0.18)
                    )
                }

                if resultFiltersOpen, inferredRecommendationCount > 0 {
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
                    VStack(alignment: .leading, spacing: 12) {
                        if hasStructuredResults {
                            HStack(alignment: .bottom) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Menu section")
                                        .font(.caption.weight(.bold))
                                        .textCase(.uppercase)
                                        .foregroundStyle(AppPalette.muted)
                                    Text(section.label)
                                        .font(AppTypography.display(size: 22, weight: .heavy))
                                        .tracking(-0.44)
                                        .foregroundStyle(AppPalette.ink)
                                }

                                Spacer()

                                Text("\(section.recommendations.count) wine\(section.recommendations.count == 1 ? "" : "s")")
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(AppPalette.muted)
                            }
                        }

                        VStack(spacing: 12) {
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
        VStack(alignment: .leading, spacing: 14) {
            controlGroup(title: "Sort by") {
                HStack(spacing: 0) {
                    chipButton(
                        title: ResultSortOrder.recommended.label,
                        isSelected: resultSortOrder == .recommended
                    ) {
                        resultSortOrder = .recommended
                    }
                    .accessibilityIdentifier("sort-most-recommended")

                    chipButton(
                        title: ResultSortOrder.discovered.label,
                        isSelected: resultSortOrder == .discovered
                    ) {
                        resultSortOrder = .discovered
                    }
                    .accessibilityIdentifier("sort-image-order")
                }
                .padding(3)
                .background(Color.white, in: Capsule())
                .overlay(
                    Capsule()
                        .stroke(AppPalette.line, lineWidth: 1)
                )
            }

            Button {
                withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
                    resultFiltersOpen.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    Text("Filters")
                    Image(systemName: resultFiltersOpen ? "chevron.up" : "chevron.down")
                        .font(.caption.weight(.bold))
                }
                .font(AppTypography.body(size: 16, weight: .medium))
                .foregroundStyle(AppPalette.muted)
            }
            .buttonStyle(.plain)

            if resultFiltersOpen {
                if inferredRecommendationCount > 0 {
                    controlGroup(title: "Taste data") {
                        HStack(spacing: 8) {
                            chipButton(
                                title: "All profiles",
                                isSelected: resultProfileFilter == .all
                            ) {
                                resultProfileFilter = .all
                            }
                            .accessibilityIdentifier("filter-all-profiles")

                            chipButton(
                                title: "Hide inferred",
                                isSelected: resultProfileFilter == .excludeInferred
                            ) {
                                resultProfileFilter = .excludeInferred
                            }
                            .accessibilityIdentifier("filter-hide-inferred")
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
                            .accessibilityIdentifier("include-unpriced-toggle")
                            .font(.footnote)
                            .tint(AppPalette.accentRed)
                        }
                        .padding(14)
                        .background(AppPalette.cardSecondary, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    }
                }
            }
        }
    }

    private func sectionBrowser(sections: [ResultSection], totalCount: Int) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
                    sectionBrowserOpen.toggle()
                }
            } label: {
                HStack {
                    Text("Browse by menu section")
                        .font(.caption.weight(.black))
                        .tracking(1.0)
                        .textCase(.uppercase)
                    Spacer()
                    Image(systemName: sectionBrowserOpen ? "chevron.down" : "chevron.right")
                        .font(.caption.weight(.bold))
                }
                .foregroundStyle(AppPalette.accentBlue)
            }
            .buttonStyle(.plain)

            if sectionBrowserOpen {
                Text("Jump between source tabs and sections without losing the current ranking.")
                    .font(.footnote)
                    .foregroundStyle(AppPalette.muted)

                VStack(spacing: 8) {
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
            }
        }
        .padding(14)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(AppPalette.line.opacity(0.95), lineWidth: 1.2)
            )
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
                    .minimumScaleFactor(0.78)

                if let subtitle {
                    Text(subtitle)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(isSelected ? Color.white.opacity(0.9) : AppPalette.muted)
                }
            }
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(isSelected ? AppPalette.accentBlue : Color.clear, in: Capsule())
            .foregroundStyle(isSelected ? Color.white : AppPalette.ink)
            .overlay(
                Capsule()
                    .stroke(isSelected ? Color.clear : AppPalette.line.opacity(0.7), lineWidth: 1)
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
        VStack(alignment: .leading, spacing: 10) {
            ZStack(alignment: .topTrailing) {
                HStack(alignment: .top, spacing: 10) {
                    ResultImageView(imageURL: recommendation.profile?.imageUrl)

                    VStack(alignment: .leading, spacing: 8) {
                        VStack(alignment: .leading, spacing: 5) {
                            VStack(alignment: .leading, spacing: 5) {
                                if let menuContext {
                                    Text(menuContext)
                                        .font(.system(size: 10, weight: .bold))
                                        .textCase(.uppercase)
                                        .foregroundStyle(AppPalette.muted)
                                        .lineLimit(1)
                                }

                                Text(menuTitle)
                                    .font(AppTypography.display(size: 17, weight: .heavy))
                                    .tracking(-0.2)
                                    .foregroundStyle(AppPalette.ink)
                                    .lineLimit(4)
                            }
                            .padding(.trailing, 58)

                            if let matchedTitle {
                                Text("Matched to \(matchedTitle)")
                                    .font(.system(size: 13, weight: .medium))
                                    .foregroundStyle(AppPalette.muted)
                                    .lineLimit(3)
                            }

                            if isInferred {
                                Text("No reliable Vivino match was found, so this taste profile is inferred from the extracted wine details.")
                                    .font(.system(size: 12))
                                    .foregroundStyle(AppPalette.muted)
                                    .lineLimit(3)
                            }
                        }

                        Spacer(minLength: 0)

                        HStack(alignment: .bottom, spacing: 8) {
                            if showRating, let rating, let ratingCount {
                                VivinoRatingBlock(
                                    rating: rating,
                                    ratingCount: ratingCount,
                                    ratingSource: recommendation.profile?.ratingSource
                                )
                                .layoutPriority(2)
                            }

                            Spacer(minLength: 4)

                            Text(candidate?.price ?? "Price unavailable")
                                .font(.system(size: 11, weight: .bold))
                                .foregroundStyle(candidate?.price == nil ? AppPalette.muted : AppPalette.ink)
                                .lineLimit(candidate?.price == nil ? 2 : 1)
                                .multilineTextAlignment(.center)
                                .minimumScaleFactor(0.78)
                                .frame(minWidth: candidate?.price == nil ? 78 : 50, maxWidth: candidate?.price == nil ? 84 : 66)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 6)
                                .background(Color.white, in: Capsule())
                                .overlay(Capsule().stroke(AppPalette.line, lineWidth: 1))
                                .layoutPriority(1)
                        }
                    }
                    .frame(minHeight: 150, alignment: .top)
                }

                VStack(spacing: 2) {
                    Text("Fit")
                        .font(.system(size: 10, weight: .bold))
                        .textCase(.uppercase)
                    Text("\(Int(recommendation.fitScore.rounded()))")
                        .font(.system(size: 24, weight: .black))
                }
                .foregroundStyle(AppPalette.accentBlue)
                .frame(width: 50, height: 56)
                .background(AppPalette.accentBlue.opacity(0.10), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }

            VStack(alignment: .leading, spacing: 7) {
                HStack {
                    Text("What does this wine taste like?")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(AppPalette.ink)
                    Spacer()
                    if isInferred {
                        Text("Estimated profile")
                            .font(.system(size: 10, weight: .bold))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(AppPalette.accentRed.opacity(0.10), in: Capsule())
                            .foregroundStyle(AppPalette.accentRed)
                    }
                }

                VStack(spacing: 1) {
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
                        .font(.system(size: 13))
                        .foregroundStyle(AppPalette.muted)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .background(AppPalette.cardSecondary, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(AppPalette.line.opacity(0.95), lineWidth: 1.2)
            )

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
                        .font(.system(size: 15, weight: .bold))
                    Spacer()
                }
                .foregroundStyle(AppPalette.ink)
            }
            .tint(AppPalette.ink)
        }
        .padding(10)
        .background(AppPalette.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(AppPalette.line.opacity(0.95), lineWidth: 1.35)
                .allowsHitTesting(false)
        )
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("result-card-\(recommendation.candidateId)")
    }
}

private struct CameraCaptureView: UIViewControllerRepresentable {
    @Environment(\.dismiss) private var dismiss

    let onImageCaptured: (UIImage) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.delegate = context.coordinator
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        let parent: CameraCaptureView

        init(parent: CameraCaptureView) {
            self.parent = parent
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            if let image = info[.originalImage] as? UIImage {
                parent.onImageCaptured(image)
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}

private struct PhotoLibraryPickerView: UIViewControllerRepresentable {
    @Environment(\.dismiss) private var dismiss

    let onImageDataSelected: (Data) -> Void

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var configuration = PHPickerConfiguration(photoLibrary: .shared())
        configuration.filter = .images
        configuration.selectionLimit = 1
        configuration.preferredAssetRepresentationMode = .compatible

        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: PHPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let parent: PhotoLibraryPickerView

        init(parent: PhotoLibraryPickerView) {
            self.parent = parent
        }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            parent.dismiss()
            guard let provider = results.first?.itemProvider else {
                return
            }

            if provider.canLoadObject(ofClass: UIImage.self) {
                provider.loadObject(ofClass: UIImage.self) { [parent] object, _ in
                    guard let image = object as? UIImage, let data = image.jpegData(compressionQuality: 0.92) else {
                        return
                    }

                    DispatchQueue.main.async {
                        parent.onImageDataSelected(data)
                    }
                }
            }
        }
    }
}

private struct ResultImageView: View {
    let imageURL: String?

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
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
                            .padding(.horizontal, 5)
                            .padding(.vertical, 6)
                    default:
                        Image(systemName: "wineglass.fill")
                            .font(.system(size: 22))
                            .foregroundStyle(AppPalette.accentBlue)
                    }
                }
            } else {
                Image(systemName: "wineglass.fill")
                    .font(.system(size: 22))
                    .foregroundStyle(AppPalette.accentBlue)
            }
        }
        .frame(width: 88, height: 150)
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(AppPalette.line, lineWidth: 1)
        )
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
        HStack(alignment: .bottom, spacing: 6) {
            Text(String(format: "%.1f", max(0, min(5, rating))))
                .font(.system(size: 20, weight: .black))
                .foregroundStyle(AppPalette.ink)
                .fontDesign(.default)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 1) {
                    ForEach(0..<5, id: \.self) { index in
                        Image(systemName: starSymbol(for: index))
                            .foregroundStyle(AppPalette.accentRed)
                            .font(.system(size: 11, weight: .bold))
                    }
                }
                .fixedSize(horizontal: true, vertical: false)

                Text("\(formatCount(ratingCount)) rating\(ratingCount == 1 ? "" : "s")\(ratingSource == .wine ? " - all vintages" : "")")
                    .font(.system(size: 10))
                    .foregroundStyle(AppPalette.muted)
                    .lineLimit(1)
                    .minimumScaleFactor(0.62)
            }
            .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
        }
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
    let isActive: Bool
    let isBusy: Bool
    let pollingPaused: Bool
    let pollingStatusMessage: String?
    let onCancel: () -> Void
    let onResume: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(progress.title)
                        .font(.system(size: 13, weight: .black))
                        .textCase(.uppercase)
                        .tracking(1.2)
                        .foregroundStyle(progress.tint)
                    Text(progress.detail)
                        .font(.system(size: 16))
                        .foregroundStyle(AppPalette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer()

                Text(progress.countLabel)
                    .font(.system(size: 22, weight: .black))
                    .foregroundStyle(progress.tint)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(progress.tint.opacity(0.12), in: Capsule())
            }

            GeometryReader { geometry in
                let fraction = progress.fraction ?? 0.30
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(progress.tint.opacity(0.10))
                    Capsule()
                        .fill(
                            LinearGradient(
                                colors: [progress.tint, progress.tint.opacity(0.72)],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(width: max(progress.processed > 0 ? 18 : 0, geometry.size.width * CGFloat(fraction)))
                }
            }
            .frame(height: 14)

            if let pollingStatusMessage {
                Text(pollingStatusMessage)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(pollingPaused ? AppPalette.accentRed : AppPalette.muted)
            }

            if isActive, pollingPaused {
                Button("Resume Updates", action: onResume)
                    .accessibilityIdentifier("resume-updates-button")
                    .buttonStyle(OutlineActionButtonStyle())
            }
        }
        .padding(16)
        .background(AppPalette.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(progress.tint.opacity(0.24), lineWidth: 1.35)
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
                if !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(AppPalette.muted)
                }
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

private struct OnboardingDots: View {
    let currentStep: Int

    var body: some View {
        HStack(spacing: 5) {
            Capsule()
                .fill(currentStep == 1 ? AppPalette.accentBlue : AppPalette.accentBlue.opacity(0.42))
                .frame(width: currentStep == 1 ? 20 : 7, height: 7)
            Capsule()
                .fill(currentStep == 2 ? AppPalette.accentBlue : AppPalette.track)
                .frame(width: currentStep == 2 ? 20 : 7, height: 7)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityHidden(true)
    }
}

private struct SectionNavigationDots: View {
    let activeIndex: Int
    let onSelect: (Int) -> Void

    var body: some View {
        VStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { index in
                Button {
                    onSelect(index)
                } label: {
                    if index == activeIndex {
                        Capsule()
                            .fill(AppPalette.accentBlue)
                            .frame(width: 7, height: 20)
                    } else {
                        Circle()
                            .fill(AppPalette.line)
                            .frame(width: 7, height: 7)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("section-nav-\(index)")
                .accessibilityLabel(sectionLabel(for: index))
            }
        }
        .frame(width: 18)
    }

    private func sectionLabel(for index: Int) -> String {
        switch index {
        case 0:
            return "Go to intro"
        case 1:
            return "Go to source"
        default:
            return "Go to results"
        }
    }
}

private struct SurfaceCard<Content: View>: View {
    let width: CGFloat?
    let content: Content

    init(width: CGFloat? = nil, @ViewBuilder content: () -> Content) {
        self.width = width
        self.content = content()
    }

    var body: some View {
        let panelPadding: CGFloat = 24

        if let width {
            let innerWidth = max(0, width - (panelPadding * 2))

            VStack(alignment: .leading, spacing: 0) {
                content
            }
            .frame(width: innerWidth, alignment: .leading)
            .padding(panelPadding)
            .frame(width: width, alignment: .leading)
            .background(Color.white.opacity(0.96), in: RoundedRectangle(cornerRadius: AppLayout.panelRadius, style: .continuous))
            .overlay(ResultsPanelBorder())
            .shadow(color: .black.opacity(0.10), radius: 26, y: 14)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                content
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(panelPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.white.opacity(0.96), in: RoundedRectangle(cornerRadius: AppLayout.panelRadius, style: .continuous))
            .overlay(ResultsPanelBorder())
            .shadow(color: .black.opacity(0.10), radius: 26, y: 14)
        }
    }
}

private struct ResultsPanelBorder: View {
    var body: some View {
        let warmEdge = Color(red: 0.78, green: 0.75, blue: 0.68).opacity(0.42)

        ZStack {
            RoundedRectangle(cornerRadius: AppLayout.panelRadius, style: .continuous)
                .stroke(Color.white.opacity(0.86), lineWidth: 2)
            RoundedRectangle(cornerRadius: AppLayout.panelRadius, style: .continuous)
                .inset(by: 0.5)
                .stroke(warmEdge, lineWidth: 0.75)
        }
        .allowsHitTesting(false)
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

private struct SourceDropZone: View {
    let isReading: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 10) {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(AppPalette.accentBlue)

                VStack(spacing: 5) {
                    Text("Drop a photo, screenshot, or PDF here")
                        .font(AppTypography.body(size: 16, weight: .heavy))
                        .foregroundStyle(AppPalette.ink)
                        .multilineTextAlignment(.center)

                    Text(isReading ? "Reading image with Apple Vision OCR..." : "or click to browse")
                        .font(AppTypography.body(size: 14))
                        .foregroundStyle(AppPalette.muted)
                        .multilineTextAlignment(.center)
                }

                if isReading {
                    ProgressView()
                        .tint(AppPalette.accentBlue)
                        .padding(.top, 2)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: 96)
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .background(Color.white.opacity(0.45), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(
                        AppPalette.accentBlue.opacity(0.25),
                        style: StrokeStyle(lineWidth: 2, dash: [5, 5])
                    )
                    .allowsHitTesting(false)
            )
        }
        .accessibilityIdentifier("source-drop-zone")
        .buttonStyle(.plain)
    }
}

private struct StoryImageBreakCard: View {
    let title: String
    let imageName: String
    let isLeading: Bool
    var minimumHeight: CGFloat = max(360, UIScreen.main.bounds.height * 0.5)

    var body: some View {
        ZStack {
            Image(imageName)
                .resizable()
                .scaledToFill()
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            LinearGradient(
                colors: [
                    Color.black.opacity(0.45),
                    Color.black.opacity(0.45)
                ],
                startPoint: .top,
                endPoint: .bottom
            )

            Text(title)
                .font(AppTypography.display(size: 30))
                .tracking(-0.6)
                .multilineTextAlignment(.center)
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 24)
        }
        .frame(maxWidth: .infinity)
        .frame(height: minimumHeight)
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
        AppPalette.background
            .ignoresSafeArea()
    }
}

private struct TasteScaleRow: View {
    let dimension: TasteDimension
    let value: Int?
    let tone: TasteScaleTone
    var onChange: ((Int) -> Void)?

    var body: some View {
        let isInteractive = onChange != nil
        let markerWidth: CGFloat = isInteractive ? 52 : 32
        let trackHeight: CGFloat = isInteractive ? 10 : 8
        let labelWidth: CGFloat = isInteractive ? 72 : 52
        let labelSize: CGFloat = isInteractive ? 15 : 11
        let rowSpacing: CGFloat = isInteractive ? 10 : 5

        HStack(spacing: rowSpacing) {
            Text(dimension.lowLabel)
                .font(.system(size: labelSize, weight: .semibold))
                .foregroundStyle(AppPalette.ink)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .frame(width: labelWidth, alignment: .leading)

            ZStack {
                GeometryReader { geometry in
                    let trackWidth = geometry.size.width
                    ZStack(alignment: .leading) {
                        Capsule()
                            .fill(tone == .uncertain ? AppPalette.trackMuted : AppPalette.track)
                            .frame(height: trackHeight)

                        if let value {
                            Capsule()
                                .fill(tone == .uncertain ? AppPalette.muted : AppPalette.accentBlue)
                                .frame(width: markerWidth, height: trackHeight)
                                .shadow(color: (tone == .uncertain ? AppPalette.muted : AppPalette.accentBlue).opacity(isInteractive ? 0.22 : 0.16), radius: isInteractive ? 7 : 4, y: isInteractive ? 3 : 2)
                                .offset(x: tasteMarkerOffset(value: value, width: trackWidth, markerWidth: markerWidth))
                        }
                    }
                    .frame(height: geometry.size.height)
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { gesture in
                                guard let onChange else { return }
                                let available = max(1, trackWidth - markerWidth)
                                let clampedX = min(max(gesture.location.x - markerWidth / 2, 0), available)
                                let next = Int((clampedX / available * 4).rounded()) + 1
                                onChange(max(1, min(5, next)))
                            }
                    )
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
                    .accessibilityIdentifier("taste-\(dimension.testIdentifier)-slider")
                    .opacity(0.02)
                }
            }
            .frame(height: isInteractive ? 26 : 16)

            Text(dimension.highLabel)
                .font(.system(size: labelSize, weight: .semibold))
                .foregroundStyle(AppPalette.ink)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .frame(width: labelWidth, alignment: .trailing)
        }
    }
}

private struct PrimaryActionButtonStyle: ButtonStyle {
    var fullWidth = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(AppTypography.body(size: 17, weight: .heavy))
            .foregroundStyle(.white)
            .frame(maxWidth: fullWidth ? .infinity : nil)
            .padding(.horizontal, 32)
            .padding(.vertical, 15)
            .background(
                RoundedRectangle(cornerRadius: AppLayout.controlRadius, style: .continuous)
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
            .font(AppTypography.body(size: 15, weight: .bold))
            .foregroundStyle(.white)
            .lineLimit(1)
            .minimumScaleFactor(0.82)
            .frame(maxWidth: fullWidth ? .infinity : nil)
            .frame(minHeight: 38)
            .padding(.horizontal, 18)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: AppLayout.controlRadius, style: .continuous)
                    .fill(configuration.isPressed ? AppPalette.accentRed.opacity(0.84) : AppPalette.accentRed)
            )
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
}

private struct ResultsActionButtonStyle: ButtonStyle {
    var minWidth: CGFloat

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .heavy))
            .foregroundStyle(.white)
            .lineLimit(1)
            .minimumScaleFactor(0.86)
            .frame(minWidth: minWidth)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(
                RoundedRectangle(cornerRadius: AppLayout.controlRadius, style: .continuous)
                    .fill(configuration.isPressed ? AppPalette.accentRed.opacity(0.84) : AppPalette.accentRed)
            )
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
}

private struct OutlineActionButtonStyle: ButtonStyle {
    var tint = AppPalette.accentBlue

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(AppTypography.body(size: 14, weight: .bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Color.white.opacity(0.92), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(AppPalette.line, lineWidth: 1)
            )
            .opacity(configuration.isPressed ? 0.84 : 1)
    }
}

private struct NavToggleButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(AppTypography.body(size: 14, weight: .bold))
            .foregroundStyle(AppPalette.accentBlue)
            .lineLimit(1)
            .frame(width: 72)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(Color.clear, in: RoundedRectangle(cornerRadius: AppLayout.controlRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: AppLayout.controlRadius, style: .continuous)
                    .stroke(AppPalette.line.opacity(0.95), lineWidth: 1)
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
            return "Best fit"
        case .discovered:
            return "Menu order"
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

    var testIdentifier: String {
        switch self {
        case .body:
            return "body"
        case .tannin:
            return "tannin"
        case .sweetness:
            return "sweetness"
        case .acidity:
            return "acidity"
        }
    }

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

private enum AppTypography {
    static func display(size: CGFloat, weight: Font.Weight = .black) -> Font {
        .system(size: size, weight: weight, design: .default)
    }

    static func body(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .default)
    }
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

private func tasteMarkerOffset(value: Int, width: CGFloat, markerWidth: CGFloat = 42) -> CGFloat {
    let normalized = CGFloat(max(1, min(5, value)) - 1) / 4
    let available = max(0, width - markerWidth)
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
