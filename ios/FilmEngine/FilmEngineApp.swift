import SwiftUI

@main
struct FilmEngineApp: App {
    @StateObject private var settings = ServerSettings()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(settings)
                .preferredColorScheme(.dark)
        }
    }
}
