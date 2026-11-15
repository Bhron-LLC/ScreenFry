import CryptoKit
import Foundation
import Security
#if canImport(Sparkle)
import Sparkle
#endif

/// ScreenFry's version as people see it. Main releases are "1.0.2"; a beta build adds its beta
/// number ("1.0.2 Beta 1.4"), which counts beta features only: it stays the same when the beta
/// is rebuilt on a newer main release, and an "N.0" beta is identical to main.
enum AppVersion {
    /// The main release this build is (or is built on).
    static var base: String { info("CFBundleShortVersionString") }
    /// The beta number of a beta build ("1.4"), nil for main releases.
    static var beta: String? {
        let beta = info("ScreenFryBeta")
        return beta.isEmpty ? nil : beta
    }
    static var display: String { beta.map { "\(base) Beta \($0)" } ?? base }
    static var build: String { info("CFBundleVersion") }

    private static func info(_ key: String) -> String {
        Bundle.main.infoDictionary?[key] as? String ?? ""
    }
}

/// Build numbers order both lanes: a main release is a whole number ("47") and a beta built
/// on it is "47.<serial>", so a beta is newer than its main release and older than the next.
struct BuildNumber {
    let main: Int
    let beta: Int?

    init(_ string: String) {
        let parts = string.split(separator: ".").map { Int($0) ?? 0 }
        main = parts.first ?? 0
        beta = parts.count > 1 ? parts[1] : nil
    }
}

/// The experimental beta channel (Mac app checkbox "Experimental beta features").
enum BetaChannel {
    static let enabledKey = "experimentalBetaFeatures"

    static var enabled: Bool { UserDefaults.standard.bool(forKey: enabledKey) }

    static let warning = """
        Beta versions of ScreenFry include features that are still being built. They can have \
        bugs, change or disappear. They update automatically as new beta features are added, and \
        always include the latest stable version's fixes.

        While betas are on, Safari and Chrome use ScreenFry's developer extensions (store \
        versions never get beta features). Turn this off any time to go back to the stable \
        version.
        """
}

/// One version in the update feed.
struct FeedItem {
    let version: String
    let display: String
    let url: URL
    let signature: String
    let isBeta: Bool

    /// The feed's items (Sparkle's appcast format, as the release workflows write it).
    static func parse(_ xml: String) -> [FeedItem] {
        func field(_ item: String, _ pattern: String) -> String? {
            guard let regex = try? NSRegularExpression(pattern: pattern),
                  let match = regex.firstMatch(in: item, range: NSRange(item.startIndex..., in: item)),
                  let range = Range(match.range(at: 1), in: item)
            else { return nil }
            return String(item[range])
        }
        return xml.components(separatedBy: "<item>").dropFirst().compactMap { item in
            guard let version = field(item, "<sparkle:version>([^<]+)</sparkle:version>"),
                  let link = field(item, "<enclosure[^>]*url=\"([^\"]+)\""),
                  let url = URL(string: link),
                  let signature = field(item, "sparkle:edSignature=\"([^\"]+)\"")
            else { return nil }
            let display = field(item, "<sparkle:shortVersionString>([^<]+)</sparkle:shortVersionString>") ?? version
            let beta = field(item, "<sparkle:channel>([^<]+)</sparkle:channel>") == "beta"
            return FeedItem(version: version, display: display, url: url, signature: signature, isBeta: beta)
        }
    }

    /// The newest item of one lane.
    static func newest(_ items: [FeedItem], beta: Bool) -> FeedItem? {
        items.filter { $0.isBeta == beta }.max { a, b in
            let x = BuildNumber(a.version), y = BuildNumber(b.version)
            return (x.main, x.beta ?? -1) < (y.main, y.beta ?? -1)
        }
    }

    static func load(_ feed: URL, completion: @escaping (Result<[FeedItem], Error>) -> Void) {
        var request = URLRequest(url: feed)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: request) { data, _, error in
            let result: Result<[FeedItem], Error> = data.flatMap { String(data: $0, encoding: .utf8) }
                .map { .success(parse($0)) } ?? .failure(error ?? SwitchError("The update feed couldn't be read."))
            DispatchQueue.main.async { completion(result) }
        }.resume()
    }
}

struct SwitchError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

/// Moves between the stable and beta lanes right away. Sparkle installs only newer builds, and
/// going back to stable means a lower one, so the switch installs the version itself, with the
/// same checks Sparkle makes: the download must carry ScreenFry's update signature (SUPublicEDKey)
/// and the app inside must be signed by the same developer as this one.
enum LaneSwitcher {
    static func install(_ item: FeedItem, completion: @escaping (Error?) -> Void) {
        URLSession.shared.downloadTask(with: item.url) { file, _, error in
            var failure: Error?
            do {
                guard let file else { throw error ?? SwitchError("The download failed.") }
                try stage(file, item)
            } catch {
                failure = error
            }
            DispatchQueue.main.async { completion(failure) }
        }.resume()
    }

    /// Verifies the download, unpacks the app next to this one and hands the swap to a small
    /// script that waits for ScreenFry to quit, swaps the apps and opens the new one.
    private static func stage(_ download: URL, _ item: FeedItem) throws {
        let data = try Data(contentsOf: download)
        guard let keyText = Bundle.main.infoDictionary?["SUPublicEDKey"] as? String,
              let keyData = Data(base64Encoded: keyText),
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyData),
              let signature = Data(base64Encoded: item.signature),
              key.isValidSignature(signature, for: data)
        else { throw SwitchError("The download isn't signed by ScreenFry, so it wasn't installed.") }

        let fm = FileManager.default
        let app = Bundle.main.bundleURL
        let staging = try fm.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: app, create: true)
        let archive = staging.appendingPathComponent(item.url.lastPathComponent)
        try data.write(to: archive)
        let unpacked = staging.appendingPathComponent("unpacked")
        try fm.createDirectory(at: unpacked, withIntermediateDirectories: true)
        if archive.pathExtension == "dmg" {
            let mount = staging.appendingPathComponent("mount")
            try run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount.path, archive.path])
            defer { try? run("/usr/bin/hdiutil", ["detach", "-quiet", mount.path]) }
            try run("/usr/bin/ditto", [mount.appendingPathComponent(app.lastPathComponent).path, unpacked.appendingPathComponent(app.lastPathComponent).path])
        } else {
            try run("/usr/bin/ditto", ["-x", "-k", archive.path, unpacked.path])
        }
        let new = unpacked.appendingPathComponent(app.lastPathComponent)
        guard let bundle = Bundle(url: new),
              bundle.bundleIdentifier == Bundle.main.bundleIdentifier,
              bundle.infoDictionary?["CFBundleVersion"] as? String == item.version
        else { throw SwitchError("The download isn't the expected ScreenFry version.") }
        try checkSignedLikeThisApp(new)

        let script = """
            while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
            if mv "$2" "$4" && mv "$3" "$2"; then rm -rf "$4"; else [ -d "$2" ] || mv "$4" "$2"; fi
            open "$2"
            rm -rf "$5"
            """
        let swap = Process()
        swap.executableURL = URL(fileURLWithPath: "/bin/sh")
        swap.arguments = ["-c", script, "sh", String(ProcessInfo.processInfo.processIdentifier), app.path, new.path,
                          staging.appendingPathComponent("previous.app").path, staging.path]
        try swap.run()
    }

    /// Same developer and app as this copy: Apple-issued certificate, this team, this bundle ID.
    private static func checkSignedLikeThisApp(_ url: URL) throws {
        var me: SecCode?
        var info: CFDictionary?
        guard SecCodeCopySelf([], &me) == errSecSuccess, let me,
              let myStatic = staticCode(of: me),
              SecCodeCopySigningInformation(myStatic, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let team = (info as? [String: Any])?[kSecCodeInfoTeamIdentifier as String] as? String,
              let id = Bundle.main.bundleIdentifier
        else { throw SwitchError("This copy of ScreenFry isn't signed, so it can't switch versions itself.") }
        var code: SecStaticCode?
        var requirement: SecRequirement?
        let text = "anchor apple generic and identifier \"\(id)\" and certificate leaf[subject.OU] = \"\(team)\""
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code,
              SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess,
              SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate), requirement) == errSecSuccess
        else { throw SwitchError("The downloaded app isn't signed by ScreenFry's developer, so it wasn't installed.") }
    }

    private static func staticCode(of code: SecCode) -> SecStaticCode? {
        var result: SecStaticCode?
        return SecCodeCopyStaticCode(code, [], &result) == errSecSuccess ? result : nil
    }

    @discardableResult
    private static func run(_ tool: String, _ arguments: [String]) throws -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw SwitchError("Unpacking the download failed (\(URL(fileURLWithPath: tool).lastPathComponent)).")
        }
        return process.terminationStatus
    }
}

#if canImport(Sparkle)
extension BetaChannel {
    /// While betas are on, a new main release is offered only once its beta is published
    /// (it follows within the hour), so beta features never drop out in between. If the beta
    /// is more than three hours late, main is offered after all.
    static func bestItem(in items: [SUAppcastItem], hostBuild: String) -> SUAppcastItem? {
        let compare = SUStandardVersionComparator.default
        let newest = { (list: [SUAppcastItem]) in
            list.max { compare.compareVersion($0.versionString, toVersion: $1.versionString) == .orderedAscending }
        }
        guard enabled,
              let beta = newest(items.filter { $0.channel == "beta" }),
              let main = newest(items.filter { $0.channel == nil })
        else { return nil }
        let waiting = BuildNumber(main.versionString).main > BuildNumber(beta.versionString).main
            && Date().timeIntervalSince(main.date ?? .distantPast) < 3 * 3600
        guard waiting else { return nil }
        return compare.compareVersion(hostBuild, toVersion: beta.versionString) == .orderedAscending
            ? beta : SUAppcastItem.empty()
    }
}

/// Sparkle's window names this copy by its beta number ("you have 1.0.2 Beta 1.1"), not its build.
final class BetaVersionDisplay: NSObject, SUVersionDisplay {
    func formatUpdateVersion(
        fromUpdate update: SUAppcastItem,
        andBundleDisplayVersion inOutBundleDisplayVersion: AutoreleasingUnsafeMutablePointer<NSString>,
        withBundleVersion bundleVersion: String
    ) -> String {
        inOutBundleDisplayVersion.pointee = AppVersion.display as NSString
        return update.displayVersionString
    }
}
#endif
