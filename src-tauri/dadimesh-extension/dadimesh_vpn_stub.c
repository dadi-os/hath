/* Soft stubs for iOS when DadiMeshBridge.m is not yet linked in Xcode.
 * Replace by adding dadimesh-extension/DadiMeshBridge.m to the app target
 * and removing this file from the compile sources if you hit duplicate symbols.
 */
int dadimesh_vpn_ensure(void) { return 0; }
int dadimesh_vpn_start(int proxy_port) {
  (void)proxy_port;
  return 0;
}
int dadimesh_vpn_stop(void) { return 0; }
int dadimesh_vpn_write_credentials(const char *control_url, const char *auth_key,
                                   const char *node_name) {
  (void)control_url;
  (void)auth_key;
  (void)node_name;
  return 0;
}
