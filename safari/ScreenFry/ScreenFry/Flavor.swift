import Foundation

/// Which ScreenFry this is, fixed when it's built (`ScreenFryChannel` in Info.plist, set by
/// scripts/build-flavor.sh). The installer offers both, side by side:
///   - official: "ScreenFry", the full-color icon. Chrome gets ScreenFry from the Chrome Web
///     Store, which updates it. A ScreenFry folder already loaded unpacked (from before there
///     were two flavors) keeps getting updates until it's removed from Chrome.
///   - developer: "ScreenFry Developer", the greyed icon. Chrome loads the unpacked extension
///     from the folder this app keeps current (Developer mode), updated the moment the app is.
/// Both share one bundle identifier, so there is only ever one ScreenFry in Safari, and each
/// updates from its own feed (`SUFeedURL`).
enum Flavor: String {
    case official, developer

    static let current = Flavor(rawValue: Bundle.main.object(forInfoDictionaryKey: "ScreenFryChannel") as? String ?? "") ?? .official

    var name: String { self == .official ? "ScreenFry" : "ScreenFry Developer" }
    var other: Flavor { self == .official ? .developer : .official }
    /// The bundled Dock and setup-window icon (see scripts/generate-icons.mjs).
    var brandIconName: String { self == .official ? "BrandIcon" : "BrandIconDeveloper" }

    /// ScreenFry's Chrome Web Store page.
    static let chromeWebStoreURL = URL(string: "https://chromewebstore.google.com/detail/\(ChromeNativeHost.storeExtensionID)")!
    /// ScreenFry's own update feed. Leaving the beta lane always comes back to ScreenFry from
    /// here, whichever flavor the beta was (betas are ScreenFry Developer builds).
    static let officialFeedURL = URL(string: "https://github.com/Bhron-LLC/ScreenFry/releases/download/updates/appcast.xml")!
    /// Set true once the Chrome Web Store listing is public: ScreenFry Developer (not on betas)
    /// then suggests switching to ScreenFry and the Web Store version (docs/NEXT.md).
    static let chromeWebStoreIsPublic = false
    /// The latest download, which holds both flavors.
    static let downloadURL = URL(string: "https://github.com/Bhron-LLC/ScreenFry/releases/latest")!
}
