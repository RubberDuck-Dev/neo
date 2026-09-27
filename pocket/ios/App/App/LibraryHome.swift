// Where NEO Pocket keeps its books on iOS.
//
// Same principle as everywhere else NEO runs: plain files in a folder on the
// device. When the writer has iCloud Drive switched on, that folder is the
// app's iCloud folder — still local, still offline-capable, but Apple carries
// changes to the Mac in the background, where desktop NEO can point at it via
// File → Library Folder… (it shows up as iCloud Drive → NEO Pocket → NEO
// Library). With iCloud Drive off, the folder is On My iPad → NEO Pocket.
// No account is required, no dialog is shown; the shelf simply appears.

import Foundation
import Capacitor

@objc(LibraryHomePlugin)
public class LibraryHomePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LibraryHomePlugin"
    public let jsName = "LibraryHome"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "locate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fetch", returnType: CAPPluginReturnPromise)
    ]

    private static let folderName = "NEO Library"
    private static var cached: (url: URL, cloud: Bool)?

    private func home() -> (url: URL, cloud: Bool) {
        if let c = LibraryHomePlugin.cached { return c }
        let fm = FileManager.default
        var base: URL
        var cloud = false
        // url(forUbiquityContainerIdentifier:) can take a moment the first
        // time; plugin methods run off the main thread, so that's fine.
        if let container = fm.url(forUbiquityContainerIdentifier: nil) {
            base = container.appendingPathComponent("Documents", isDirectory: true)
            cloud = true
        } else {
            base = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
        }
        let lib = base.appendingPathComponent(LibraryHomePlugin.folderName, isDirectory: true)
        try? fm.createDirectory(at: lib, withIntermediateDirectories: true)
        let result = (url: lib, cloud: cloud)
        LibraryHomePlugin.cached = result
        return result
    }

    // {path: "file:///…/NEO%20Library", cloud: true|false}
    @objc func locate(_ call: CAPPluginCall) {
        let h = home()
        call.resolve(["path": h.url.absoluteString, "cloud": h.cloud])
    }

    // Files another device wrote arrive first as placeholders. Ask iCloud to
    // bring everything under `path` (default: the whole library) down, and
    // wait up to `wait` ms for it. Harmless when not on iCloud.
    @objc func fetch(_ call: CAPPluginCall) {
        let h = home()
        guard h.cloud else { call.resolve(["ready": true]); return }
        var target = h.url
        if let p = call.getString("path"), let u = URL(string: p) { target = u }
        let wait = call.getDouble("wait") ?? 6000
        let fm = FileManager.default
        let deadline = Date().addingTimeInterval(wait / 1000)
        var pending = true
        while pending {
            pending = false
            let keys: [URLResourceKey] = [.isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey, .ubiquitousItemIsDownloadingKey]
            if let en = fm.enumerator(at: target, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) {
                for case let item as URL in en {
                    let v = try? item.resourceValues(forKeys: Set(keys))
                    guard v?.isUbiquitousItem == true else { continue }
                    if let status = v?.ubiquitousItemDownloadingStatus, status != .current {
                        pending = true
                        if v?.ubiquitousItemIsDownloading != true {
                            try? fm.startDownloadingUbiquitousItem(at: item)
                        }
                    }
                }
            }
            // placeholders (".name.icloud") are hidden files; kick those too
            if let names = try? fm.contentsOfDirectory(atPath: target.path) {
                for n in names where n.hasSuffix(".icloud") {
                    pending = true
                    try? fm.startDownloadingUbiquitousItem(at: target.appendingPathComponent(n))
                }
            }
            if !pending || Date() > deadline { break }
            Thread.sleep(forTimeInterval: 0.25)
        }
        call.resolve(["ready": !pending])
    }
}

// Registers the plugin above with Capacitor. SceneDelegate creates this
// instead of the stock CAPBridgeViewController.
class NeoBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(LibraryHomePlugin())
    }
}
