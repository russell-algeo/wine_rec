# Wine Rec iPhone App

This folder contains the SwiftUI source scaffold for the iPhone app.

## Current state

- The app source is implemented against the local API contract.
- Full iOS builds are not verified in this workspace because full Xcode is not installed.

## To run once Xcode is installed

1. Install full `Xcode.app`.
2. Run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.
3. Install `xcodegen` with `brew install xcodegen`, or create the project manually in Xcode.
4. From `apps/ios`, run `xcodegen generate`.
5. Open `WineRec.xcodeproj`.
6. Set the API base URL in [AppModel.swift](/Users/russellalgeo/Desktop/Side%20Job/wine_rec/apps/ios/WineRec/Models/AppModel.swift) if your backend is not on the default host.
7. Run against the simulator or a LAN/tunneled backend for a physical device.
