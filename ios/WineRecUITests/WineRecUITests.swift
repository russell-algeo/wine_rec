import UIKit
import XCTest

final class WineRecUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUpWithError() throws {
        continueAfterFailure = false
        app.launchArguments = ["-ui-testing-reset-state"]
        app.launchEnvironment["WINE_REC_API_BASE_URL"] = "https://wine-rec.vercel.app"
        if name.contains("TasteGetStartedUrlAndCancelFlow") {
            app.launchEnvironment["WINE_REC_UI_TEST_PREFILL_URL"] = "https://grahamwine.co/collections/pinot-noir"
        }
        if name.contains("PhotoLibraryVisionOcrSubmissionResultsAndFilters") || name.contains("CameraEntryPointUsesVisionOcrSubmissionPathInSimulator") {
            app.launchEnvironment["WINE_REC_UI_TEST_FIXTURE_IMAGE_PATH"] = fixtureImagePath()
        }
        app.launch()
    }

    func testTasteGetStartedUrlAndCancelFlow() throws {
        tap(app.buttons["top-my-taste-button"])
        adjustSlider("taste-body-slider", to: 1.0)
        adjustSlider("taste-sweetness-slider", to: 0.0)
        tap(app.buttons["top-my-taste-button"])

        tap(app.buttons["get-started-button"])
        let urlField = app.textFields["wine-list-url-field"]
        XCTAssertTrue(urlField.waitForExistence(timeout: 5))
        tap(app.buttons["url-next-button"])

        XCTAssertTrue(app.buttons["analyze-button"].waitForExistence(timeout: 20))
        adjustSlider("taste-acidity-slider", to: 0.8)
        tap(app.buttons["analyze-button"])

        XCTAssertTrue(app.buttons["stop-analysis-button"].waitForExistence(timeout: 45))
        tap(app.buttons["stop-analysis-button"].firstMatch)
        XCTAssertTrue(waitForCancellationOutcome(timeout: 30))
    }

    func testPhotoLibraryVisionOcrSubmissionResultsAndFilters() throws {
        tap(app.buttons["get-started-button"])
        importFixtureImageOrOpenPicker("Photos")

        XCTAssertTrue(app.staticTexts["Selected photo.jpg"].waitForExistence(timeout: 30))
        adjustSlider("taste-tannin-slider", to: 1.0)
        tap(app.buttons["analyze-button"])

        waitForCompletedResults()
        exerciseResultControls()
    }

    func testCameraEntryPointUsesVisionOcrSubmissionPathInSimulator() throws {
        tap(app.buttons["get-started-button"])
        importFixtureImageOrOpenPicker("Camera")

        XCTAssertTrue(app.staticTexts["Selected photo.jpg"].waitForExistence(timeout: 30))
        tap(app.buttons["analyze-button"])

        waitForCompletedResults()
    }

    func testCaptureVisualParityScreenshots() throws {
        let screenshotDirectory = ProcessInfo.processInfo.environment["WINE_REC_SCREENSHOT_DIR"] ?? defaultScreenshotDirectory()

        try captureScreenshot(named: "ios-ui-hero.png", in: screenshotDirectory)

        tap(app.buttons["get-started-button"])
        XCTAssertTrue(app.textFields["wine-list-url-field"].waitForExistence(timeout: 5))
        sleep(1)
        try captureScreenshot(named: "ios-ui-ingest.png", in: screenshotDirectory)

        tap(app.buttons["section-nav-2"])
        sleep(1)
        try captureScreenshot(named: "ios-ui-results-empty.png", in: screenshotDirectory)

        tap(app.buttons["section-nav-1"])
        app.swipeUp(velocity: .slow)
        sleep(1)
        try captureScreenshot(named: "ios-ui-story-break.png", in: screenshotDirectory)
    }

    private func exerciseResultControls() {
        if app.buttons["sort-image-order"].waitForExistence(timeout: 5) {
            tap(app.buttons["sort-image-order"])
            tap(app.buttons["sort-most-recommended"])
        }

        if app.buttons["filter-all-profiles"].waitForExistence(timeout: 5) {
            tap(app.buttons["filter-all-profiles"])
            tap(app.buttons["filter-hide-inferred"])
        }

        if app.switches["include-unpriced-toggle"].waitForExistence(timeout: 5) {
            app.switches["include-unpriced-toggle"].tap()
            app.switches["include-unpriced-toggle"].tap()
        }

        if app.buttons["My Taste Preferences"].waitForExistence(timeout: 5) {
            tap(app.buttons["My Taste Preferences"])
            adjustSlider("taste-body-slider", to: 0.0)
        }

        let details = app.buttons["Tasting notes & details"].firstMatch
        if details.waitForExistence(timeout: 5) {
            details.tap()
        }
    }

    private func openImportOption(_ label: String) {
        tap(app.buttons["source-drop-zone"])
        tap(app.buttons[label].firstMatch)
    }

    private func importFixtureImageOrOpenPicker(_ label: String) {
        if app.staticTexts["Selected photo.jpg"].waitForExistence(timeout: 2) || app.buttons["analyze-button"].exists {
            return
        }

        let fixtureButton = app.buttons["ui-test-import-image-button"]
        if fixtureButton.waitForExistence(timeout: 2) {
            fixtureButton.tap()
            return
        }

        openImportOption(label)
        selectFirstPhotoFromPresentedPicker()
    }

    private func waitForCompletedResults() {
        let resultCard = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "result-card-"))
            .firstMatch
        XCTAssertTrue(resultCard.waitForExistence(timeout: 240))
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", "Failed")).firstMatch.exists)
    }

    private func waitForCancellationOutcome(timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        let stoppedText = app.staticTexts
            .containing(NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@ OR label CONTAINS[c] %@", "stopped", "canceled", "cancelled"))
            .firstMatch
        let stopButton = app.buttons["stop-analysis-button"].firstMatch
        let resultCard = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "result-card-"))
            .firstMatch

        while Date() < deadline {
            if stoppedText.exists || !stopButton.exists || resultCard.exists {
                return true
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        }

        return false
    }

    private func selectFirstPhotoFromPresentedPicker() {
        let pickerApps = [
            app,
            XCUIApplication(bundleIdentifier: "com.apple.mobileslideshow"),
            XCUIApplication(bundleIdentifier: "com.apple.PhotosUIPrivate.PhotosPicker")
        ]

        for pickerApp in pickerApps {
            tapFirstExistingButton(
                ["Continue", "Allow Full Access", "Allow Access to All Photos", "Select Photos…", "Select Photos..."],
                in: pickerApp,
                timeout: 2
            )

            let allPhotos = pickerApp.buttons["All Photos"]
            if allPhotos.waitForExistence(timeout: 2) {
                allPhotos.tap()
            }
        }

        for pickerApp in pickerApps {
            let firstCell = pickerApp.collectionViews.cells.firstMatch
            if firstCell.waitForExistence(timeout: 4), firstCell.isHittable {
                firstCell.tap()
                finishPhotoSelection(in: pickerApps)
                return
            }
        }

        for pickerApp in pickerApps.dropFirst() {
            let firstImage = pickerApp.images.firstMatch
            if firstImage.waitForExistence(timeout: 4), firstImage.isHittable {
                firstImage.tap()
                finishPhotoSelection(in: pickerApps)
                return
            }
        }

        app.coordinate(withNormalizedOffset: CGVector(dx: 0.17, dy: 0.45)).tap()
        finishPhotoSelection(in: pickerApps)
    }

    private func finishPhotoSelection(in pickerApps: [XCUIApplication]) {
        for pickerApp in pickerApps {
            let chooseButton = pickerApp.buttons["Choose"]
            if chooseButton.waitForExistence(timeout: 2) {
                chooseButton.tap()
            }

            let addButton = pickerApp.buttons["Add"]
            if addButton.waitForExistence(timeout: 2) {
                addButton.tap()
            }
        }
    }

    private func adjustSlider(_ identifier: String, to normalizedPosition: CGFloat) {
        let slider = app.sliders[identifier].firstMatch
        XCTAssertTrue(slider.waitForExistence(timeout: 5), "Missing slider \(identifier)")
        slider.adjust(toNormalizedSliderPosition: normalizedPosition)
    }

    private func enterText(_ text: String, into field: XCUIElement) {
        XCTAssertTrue(field.waitForExistence(timeout: 5), "Missing text field \(field)")
        field.tap()

        if !app.keyboards.firstMatch.waitForExistence(timeout: 2) {
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }

        if app.keyboards.firstMatch.waitForExistence(timeout: 2) {
            field.typeText(text)
            return
        }

        UIPasteboard.general.string = text
        field.press(forDuration: 0.8)
        let paste = app.menuItems["Paste"]
        XCTAssertTrue(paste.waitForExistence(timeout: 3), "Text field did not accept focus and Paste menu did not appear")
        paste.tap()
    }

    private func tap(_ element: XCUIElement, timeout: TimeInterval = 10) {
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "Missing element \(element)")
        element.tap()
    }

    @discardableResult
    private func tapFirstExistingButton(_ labels: [String], in app: XCUIApplication, timeout: TimeInterval) -> Bool {
        for label in labels {
            let button = app.buttons[label]
            if button.waitForExistence(timeout: timeout) {
                button.tap()
                return true
            }
        }

        return false
    }

    private func captureScreenshot(named name: String, in directory: String) throws {
        let directoryURL = URL(fileURLWithPath: directory, isDirectory: true)
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
        let screenshot = XCUIScreen.main.screenshot()
        try screenshot.pngRepresentation.write(to: directoryURL.appendingPathComponent(name))
    }

    private func defaultScreenshotDirectory() -> String {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("reports/wine-rec-parity", isDirectory: true)
            .path
    }

    private func fixtureImagePath() -> String {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("main/web/public/images/bottle-shelf.jpg")
            .path
    }
}
