import SwiftUI

@main
struct WineRecApp: App {
    @State private var model = AppModel()

    init() {
        if ProcessInfo.processInfo.arguments.contains("-ui-testing-reset-state") {
            UserDefaults.standard.removeObject(forKey: "wine-rec-preferences")
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(model)
        }
    }
}
