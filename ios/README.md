# Wine Rec iPhone App

This folder contains the SwiftUI source scaffold for the iPhone app.

## Current state

- The app source is implemented against the post-Vercel API contract.
- The default backend target is `https://wine-rec.vercel.app`.
- iOS simulator builds are verified in this workspace with `xcodebuild`.

## To run once Xcode is installed

1. Install full `Xcode.app`.
2. Run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.
3. Install `xcodegen` with `brew install xcodegen`, or create the project manually in Xcode.
4. From `ios`, run `xcodegen generate`.
5. Open `WineRec.xcodeproj`.
6. If you want to point the app at a non-production backend, set the Xcode scheme environment variable `WINE_REC_API_BASE_URL`.
7. For simulator-based local development, use `http://127.0.0.1:3001`.
8. Run against the simulator or a LAN/tunneled backend for a physical device.

## Automated checks (no local Xcode needed)

`.github/workflows/ios.yml` runs on GitHub's macOS runners for `claude/ios-*` branches, pull requests that touch `ios/`, and on demand. It:

- compiles and runs the plain-Swift checks (`ios/Tests/TasteEvidenceCheck.swift`, `ios/Tests/OCRLayoutCheck.swift`);
- runs Apple Vision on `ios/WineRecUITests/Fixtures/two-column-wine-list.jpg` and checks the left column is read before the right (`ios/Tests/VisionLayoutProbe.swift`);
- starts the isolated local API (`main`: `npm run dev:isolated`) so UI tests never send analyses to Production;
- builds the app and runs the UI tests on an iPhone simulator, then uploads screenshots, the `.xcresult` bundle and the API log as the `ios-test-results` artifact.

UI tests read these runner variables (pass them to `xcodebuild` with a `TEST_RUNNER_` prefix): `WINE_REC_UI_TEST_API_BASE_URL`, `WINE_REC_UI_TEST_WINE_LIST_URL`, `WINE_REC_UI_TEST_ESTIMATES_ONLY`, `WINE_REC_EXTERNAL_TEST_IMAGE_PATH`, `WINE_REC_SCREENSHOT_DIR`. Without them the tests use Production as before.
