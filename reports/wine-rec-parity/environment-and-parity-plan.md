# WineRec Environment And Visual Parity Plan

Created: 2026-05-23

## Scope

Standard: hosted web app at `https://wine-rec.vercel.app`, viewed at a mobile iPhone-sized viewport.

Goal: make the native SwiftUI iOS app visually match that mobile web experience, then prepare beta distribution for Russell and 1-2 friends.

## Artifacts Captured

- `reports/wine-rec-parity/hosted-web-mobile-390x844-first-viewport-wait5s.png`
- `reports/wine-rec-parity/hosted-web-mobile-390x844-full-wait5s.png`
- `reports/wine-rec-parity/web-mobile-390x844-first-viewport.png`
- `reports/wine-rec-parity/web-mobile-390x844-full.png`

The hosted and local web captures match after allowing image assets to settle.

## Environment Status

Available locally:

- `git`
- GitHub access to `russell-algeo/wine_rec`
- `node`, `npm`, `npx`
- `brew`
- Web dependencies installed in `main/`
- Playwright Chromium installed for deterministic web screenshots

Not currently available or active:

- Full Xcode. `xcodebuild` exists but reports that `/Library/Developer/CommandLineTools` is selected.
- iOS Simulator tooling. `xcrun simctl` is unavailable.
- `xcodegen` is not in PATH.
- CocoaPods is not in PATH, though this project does not appear to need Pods.

## Required User Actions

1. Install full `Xcode.app` from the Mac App Store or Apple Developer downloads.
2. Launch Xcode once and let it install required components.
3. Accept the license if prompted.
4. If admin auth is needed, run or approve:
   `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`
5. Install XcodeGen, or let me install it with Homebrew after Xcode is present:
   `brew install xcodegen`
6. For TestFlight, confirm access to an active Apple Developer Program account and App Store Connect.
7. Decide whether the 1-2 friends should be external TestFlight testers or App Store Connect internal users.

## TestFlight Notes

Based on Apple documentation checked on 2026-05-23:

- TestFlight is managed through App Store Connect.
- Internal testing supports up to 100 App Store Connect users with access to the app.
- External testing supports up to 10,000 testers.
- External testers require a TestFlight beta review for the first build in an external group.
- Internal-only TestFlight distribution can avoid the external beta review path, but internal testers need App Store Connect user access.

References:

- https://developer.apple.com/testflight/
- https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/
- https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers
- https://developer.apple.com/documentation/Xcode/distributing-your-app-for-beta-testing-and-releases

## Web Mobile Baseline

At 390x844:

- Fixed top nav is 56px tall, cream translucent, with left vertical section dots, bold `Wine Rec`, and a bordered `My Taste` button.
- Hero image is full-bleed, portrait-cropped, about one viewport plus extra mobile browser allowance.
- Hero copy is bottom-left, with large uppercase white `WINE REC`, one-line lede, and red rounded CTA.
- Ingest section has cream background, centered content, right-aligned step dots, large bold heading, muted copy, white rounded URL input, uppercase divider, dashed blue upload zone, and small red `Next ->` button aligned right.
- Image break sections are full-bleed, approximately half viewport height, dark overlay, centered uppercase white display text.
- Results empty state is a white rounded card with subtle blue/warm border and soft shadow, inset from viewport.

## Current iOS Structure

The iOS app is native SwiftUI and already mirrors the web page order:

1. Hero
2. Ingest/source step
3. First image break
4. Results
5. Second image break

Important files:

- `ios/WineRec/Views/ContentView.swift`
- `ios/WineRec/Models/AppModel.swift`
- `ios/WineRec/Models/APIClient.swift`
- `ios/WineRec/Models/VisionOCRService.swift`
- `ios/project.yml`
- `ios/WineRecUITests/WineRecUITests.swift`

## First-Pass Visual Gap List

These are static/code-and-web-screenshot findings. They need simulator confirmation once Xcode is installed.

### 1. Typography Scale Is Likely Too Small On iOS Hero

Web mobile hero uses `clamp(4rem, 12vw, 10rem)`, rendering around 46-47px at 390px wide. iOS uses 50px for normal compact widths and 46px below 360px. That is close, but the web's display font stack uses `Birdie`, falling back to Inter/system; iOS uses system default. If Birdie is available on Russell's phone or web environment, iOS will still look different. If not, the heavier system face may be close but needs pixel check.

Plan:
- Verify whether `Birdie` actually resolves on hosted web.
- If web uses system fallback, keep iOS system but tune weight/tracking/line height.
- If Birdie is a real brand font, add it to the iOS bundle and use it in `AppTypography.display`.

### 2. Hero Vertical Placement May Differ

Web mobile pushes hero content above browser chrome with `calc(3rem + (100lvh - 100svh) + 50px)`. iOS uses a fixed `.padding(.bottom, 172)`. That may land differently across iPhone sizes because the native app has no Safari toolbar but does have safe areas.

Plan:
- Replace fixed bottom padding with a geometry/safe-area-based calculation that matches the 390x844 visual target.
- Verify on at least iPhone SE-sized and Pro-sized simulators.

### 3. Hero Gradient Direction Is Similar But Not Identical

Web gradient is strongest at bottom and transparent by 70%; iOS uses stops from near-clear top to dark bottom plus an extra top gradient. This may make the top of the image darker or the copy area heavier than web.

Plan:
- Match the web gradient stops more directly in SwiftUI.
- Remove or reduce the extra top gradient if simulator screenshots show excess darkening.

### 4. Ingest Section Vertical Rhythm Needs Confirmation

Web ingest section begins immediately after the hero with about 48-80px top padding depending viewport. iOS uses `sectionTopPadding = 126`, then additional bottom padding. This is likely too tall if the native screenshot is meant to match the hosted mobile screenshot exactly.

Plan:
- Tune `sectionTopPadding` for ingest/results separately instead of sharing one constant.
- Match the web full-page screenshot section breaks at 390px wide.

### 5. Upload Box Height Likely Too Tall On iOS

Web mobile upload zone has min-height `8rem` and padding `1.5rem 1rem`; iOS uses minHeight 142 plus 20px vertical padding. The iOS box may be taller and more spacious.

Plan:
- Reduce native drop zone minimum height and internal spacing to match the web screenshot.
- Check icon size; web icon appears about 28px, iOS uses 29px and is likely fine.

### 6. CTA And Button Text Differ Slightly

Web uses `Next →` with an arrow glyph; iOS uses `"Next ->"` and `"Analyze ->"`. Visual parity should use the same arrow glyph and spacing if the font supports it.

Plan:
- Change iOS button labels to `Next →` and `Analyze →`.
- Confirm no accessibility regression.

### 7. Image Break Height And Cropping Need Simulator Check

Web image breaks are `min-height: 50vh`; iOS uses `max(360, UIScreen.main.bounds.height * 0.5)`. On a 844px target, iOS height is 422px while web captured about 422px. This is likely close, but image crop positions need native screenshot verification.

Plan:
- Keep height formula initially.
- Compare native screenshots for image focal point and text position.
- Adjust `Image(...).scaledToFill()` frame/alignment if crop differs.

### 8. Results Card Width And Border May Differ

Web results card width is `calc(100vw - 2rem)` with 16px side margins. iOS passes width as `geometry.size.width - 16`, yielding 8px side margins. That is probably too wide compared with the web screenshot.

Plan:
- Set `resultsHorizontalInset` to 16, or make results use the same 16px content margin as web.
- Recheck card radius, border, and shadow after simulator capture.

### 9. Status Bar Is Hidden On iOS

iOS calls `.statusBarHidden(true)` and `Info.plist` also hides the status bar. The hosted web screenshot is Safari-like and does not show iOS status bar in Playwright, so this may be acceptable for visual parity. For real installed app feel, hiding the status bar is a product choice.

Plan:
- Keep hidden for screenshot parity unless Russell wants a more native iPhone presentation.

## Verification Plan After Xcode

1. Select full Xcode and confirm:
   `xcodebuild -version`
   `xcrun simctl list devices available`
2. Install/generate project if needed:
   `brew install xcodegen`
   `cd ios && xcodegen generate`
3. Build for simulator:
   `xcodebuild -project ios/WineRec.xcodeproj -scheme WineRec -destination 'platform=iOS Simulator,name=iPhone 15' build`
4. Run UI tests if a simulator target is available:
   `xcodebuild -project ios/WineRec.xcodeproj -scheme WineRec -destination 'platform=iOS Simulator,name=iPhone 15' test`
5. Capture native screenshots of:
   - first viewport hero
   - ingest section
   - image break/results area
   - taste drawer
   - preference confirmation step
   - at least one result card if fixtures or API data can provide one
6. Compare against hosted web screenshots and update this report with confirmed pixel-level differences.

## Implementation Order

1. Environment unblock: full Xcode and simulator.
2. Screenshot harness: repeatable hosted-web and iOS simulator captures.
3. Low-risk visual constants:
   - results side margins
   - `Next →`/`Analyze →`
   - ingest/results top padding split
   - drop-zone height/padding
4. Hero pass:
   - typography/font
   - bottom offset
   - gradient stops
5. Image break and results-card pass.
6. UI test/build verification.
7. TestFlight signing/archive prep.

## Current Blocker

Cannot run simulator, build, archive, install to iPhone, or submit to TestFlight until full Xcode is installed and selected.

## Final Status - 2026-05-23 22:34 EDT

The original Xcode blocker was resolved by using Xcode 16.2 at `/Users/hal/Downloads/Xcode.app` through `DEVELOPER_DIR`.

Visual parity is implemented and verified against the hosted mobile web baseline for:

- Hero
- Ingest/upload
- Empty results

Final comparison artifacts:

- `reports/wine-rec-parity/comparison-viewport-latest-all.png`
- `reports/wine-rec-parity/comparison-viewport-latest-all.jpg`
- `reports/wine-rec-parity/comparison-viewport-latest-hero.png`
- `reports/wine-rec-parity/comparison-viewport-latest-ingest-upload.png`
- `reports/wine-rec-parity/comparison-viewport-latest-empty-results.png`

Verification passed:

- `npm run typecheck --workspace @wine-rec/web`
- `npm run build --workspace @wine-rec/web`
- iPhone 16 screenshot parity UI test
- Full iPhone 16 UI suite: 4 tests, 0 failures

The full UI suite covers:

- URL confirmation/cancel flow
- Photo/OCR-style recognized-text submission, results, and filters
- Camera-entry submission path
- Visual parity screenshot capture

Native simulator geometry still differs from the web screenshot in expected ways: iOS has simulator safe-area/home-indicator geometry and slightly different rasterized image crop behavior. The current native layout is close enough to treat as visual parity for this app.

## TestFlight / Device Readiness

Remaining blocker is signing, not app build/test health:

- Bundle id: `com.russellalgeo.WineRec`
- `ios/project.yml` currently has `DEVELOPMENT_TEAM: ""`
- Device install, archive, and TestFlight require an Apple Developer team id and App Store Connect access.

Next signing steps:

1. Set `DEVELOPMENT_TEAM` for `WineRec` and `WineRecUITests`.
2. Regenerate `ios/WineRec.xcodeproj` with XcodeGen.
3. Build/install on Russell's iPhone.
4. Archive with Xcode.
5. Create or connect the App Store Connect app record.
6. Upload the archive and use TestFlight for external testers.

## Real Device Visual Polish - 2026-05-24 00:35 EDT

Russell reported real iPhone clipping and visual issues after pulling the first parity branch. Follow-up fixes now applied:

- Top nav and the taste drawer respect the top safe area, so `Wine Rec`, `My Taste`, and `Close` no longer collide with the Dynamic Island.
- Hero copy and `Get Started` are raised above the home-indicator area.
- Ingest and results scroll destinations include fixed-header landing padding so auto-scroll does not place section headers under the nav.
- Results action buttons use a fixed minimum height so `Adjust Preferences` and `Stop Analysis` are visually consistent.
- Missing price labels use compact `No price` copy to avoid overlapping the rating block.
- Budget filter controls force dark foreground text over the tan card background.
- UI-test fixture import now prefers an externally supplied image path before falling back to bundled art, so real menu screenshots can be rendered in captured previews when the files are available.

Additional comparison artifacts:

- `reports/wine-rec-parity/comparison-viewport-latest-taste-drawer-open.jpg`
- `reports/wine-rec-parity/comparison-viewport-latest-upload-source-step.jpg`
- `reports/wine-rec-parity/comparison-viewport-latest-selected-menu-image.jpg`
- `reports/wine-rec-parity/comparison-viewport-latest-confirm-preferences.jpg`
- `reports/wine-rec-parity/comparison-viewport-latest-completed-results.jpg`
- `reports/wine-rec-parity/comparison-viewport-latest-results-filters-open.jpg`

Verification passed after these changes:

- iPhone 16 targeted visual screenshot UI test: passed
- iPhone 16 targeted actual-flow screenshot UI test: passed
- Full iPhone 16 UI suite: 5 tests, 0 failures

Note: Russell attached three menu photos for additional visual checks. The inbound files were visible briefly under `/Users/hal/.openclaw/media/inbound` but disappeared before they could be copied into the project/report directory, so true attached-image visual validation still needs those photos reattached or copied to a durable local path.
