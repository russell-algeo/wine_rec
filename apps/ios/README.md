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
4. From `apps/ios`, run `xcodegen generate`.
5. Open `WineRec.xcodeproj`.
6. If you want to point the app at a non-production backend, set the Xcode scheme environment variable `WINE_REC_API_BASE_URL`.
7. For simulator-based local development, use `http://127.0.0.1:3001`.
8. Run against the simulator or a LAN/tunneled backend for a physical device.
