//
// dadiMesh Packet Tunnel Provider
// Bundle this Network Extension target into the Hath iOS / macOS app
// (Xcode: File → New → Target → Packet Tunnel Provider, then replace sources).
//
// Bundle ID: com.dadi.hath.dadimesh
// Display name in Settings → VPN: dadiMesh
// App Group: group.com.dadi.hath
//
// L3 settings steer Tailscale CGNAT (100.64.0.0/10) and MagicDNS (100.100.100.100)
// for *.dadi. Full packet crypto runs in the engine that owns the WireGuard
// keys (desktop: system tailscaled; iOS: in-process dialer until the extension
// embeds the stack). HTTP(S) proxy for *.dadi remains as a Hath-compatible path.
//

import NetworkExtension
import Foundation

class PacketTunnelProvider: NEPacketTunnelProvider {
    private let appGroup = "group.com.dadi.hath"

    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        let port = proxyPortFromOptions(options) ?? readSharedProxyPort() ?? 0

        let settings = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: "127.0.0.1")

        // Tailscale CGNAT — device-wide L3 path for ssh/ping to mesh nodes.
        let ipv4 = NEIPv4Settings(addresses: ["100.100.100.100"], subnetMasks: ["255.255.255.255"])
        let mesh = NEIPv4Route(destinationAddress: "100.64.0.0", subnetMask: "255.192.0.0")
        ipv4.includedRoutes = [mesh]
        ipv4.excludedRoutes = []
        settings.ipv4Settings = ipv4

        let dns = NEDNSSettings(servers: ["100.100.100.100"])
        dns.matchDomains = ["dadi"]
        dns.matchDomainsNoSearch = false
        settings.dnsSettings = dns

        // Hath UI / Safari HTTP(S) to *.dadi via the local dialer when present.
        if port > 0 {
            let proxy = NEProxySettings()
            proxy.httpEnabled = true
            proxy.httpsEnabled = true
            proxy.httpServer = NEProxyServer(address: "127.0.0.1", port: Int(port))
            proxy.httpsServer = NEProxyServer(address: "127.0.0.1", port: Int(port))
            proxy.matchDomains = ["dadi"]
            settings.proxySettings = proxy
        }

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
