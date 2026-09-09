//
// dadiMesh Packet Tunnel Provider
// Bundle this Network Extension target into the Hath iOS app
// (Xcode: File → New → Target → Packet Tunnel Provider, then replace sources).
//
// Bundle ID: com.dadi.hath.dadimesh
// Display name in Settings → VPN: dadiMesh
// App Group: group.com.dadi.hath
//

import NetworkExtension
import Foundation

class PacketTunnelProvider: NEPacketTunnelProvider {
    private let appGroup = "group.com.dadi.hath"

    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        let port = proxyPortFromOptions(options) ?? readSharedProxyPort() ?? 0
        guard port > 0 else {
            completionHandler(
                NSError(
                    domain: "dadiMesh",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "dadiMesh dialer port missing"]
                )
            )
            return
        }

        let settings = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: "127.0.0.1")
        let proxy = NEProxySettings()
        proxy.httpEnabled = true
        proxy.httpsEnabled = true
        proxy.httpServer = NEProxyServer(address: "127.0.0.1", port: Int(port))
        proxy.httpsServer = NEProxyServer(address: "127.0.0.1", port: Int(port))
        proxy.matchDomains = ["dadi"]
        settings.proxySettings = proxy

        let dns = NEDNSSettings(servers: ["1.1.1.1"])
        dns.matchDomains = ["dadi"]
        dns.matchDomainsNoSearch = false
        settings.dnsSettings = dns

        setTunnelNetworkSettings(settings) { error in
            completionHandler(error)
        }
    }

    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        completionHandler()
    }

    private func proxyPortFromOptions(_ options: [String: NSObject]?) -> Int? {
        if let n = options?["proxyPort"] as? NSNumber {
            return n.intValue
        }
        return nil
    }

    private func readSharedProxyPort() -> Int? {
        guard let defaults = UserDefaults(suiteName: appGroup) else { return nil }
        let port = defaults.integer(forKey: "dadimesh.proxyPort")
        return port > 0 ? port : nil
    }
}
