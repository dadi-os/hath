#import <Foundation/Foundation.h>
#import <NetworkExtension/NetworkExtension.h>

static NSString *const kDadiMeshAppGroup = @"group.com.dadi.hath";
static NSString *const kDadiMeshBundleId = @"com.dadi.hath.dadimesh";

static int dadimesh_save_shared(NSString *key, NSString *value) {
  NSUserDefaults *defaults = [[NSUserDefaults alloc] initWithSuiteName:kDadiMeshAppGroup];
  if (!defaults) {
    return 1;
  }
  [defaults setObject:value forKey:key];
  [defaults synchronize];
  return 0;
}

int dadimesh_vpn_write_credentials(const char *control_url, const char *auth_key, const char *node_name) {
  if (!control_url || !auth_key || !node_name) {
    return 1;
  }
  int a = dadimesh_save_shared(@"dadimesh.controlUrl", [NSString stringWithUTF8String:control_url]);
  int b = dadimesh_save_shared(@"dadimesh.authKey", [NSString stringWithUTF8String:auth_key]);
  int c = dadimesh_save_shared(@"dadimesh.nodeName", [NSString stringWithUTF8String:node_name]);
  return a | b | c;
}

int dadimesh_vpn_ensure(void) {
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  __block int result = 1;

  [NETunnelProviderManager loadAllFromPreferencesWithCompletionHandler:^(NSArray<NETunnelProviderManager *> * _Nullable managers, NSError * _Nullable error) {
    if (error) {
      result = 2;
      dispatch_semaphore_signal(sem);
      return;
    }

    NETunnelProviderManager *manager = managers.firstObject;
    if (!manager) {
      manager = [[NETunnelProviderManager alloc] init];
    }

    NETunnelProviderProtocol *proto = [[NETunnelProviderProtocol alloc] init];
    proto.providerBundleIdentifier = kDadiMeshBundleId;
    proto.serverAddress = @"dadiMesh";
    manager.protocolConfiguration = proto;
    manager.localizedDescription = @"dadiMesh";
    manager.enabled = YES;
    // No On Demand — explicit join/leave only.
    manager.onDemandEnabled = NO;
    manager.onDemandRules = @[];

    [manager saveToPreferencesWithCompletionHandler:^(NSError * _Nullable saveError) {
      result = saveError ? 3 : 0;
      dispatch_semaphore_signal(sem);
    }];
  }];

  dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(15 * NSEC_PER_SEC)));
  return result;
}

int dadimesh_vpn_start(int proxy_port) {
  NSUserDefaults *defaults = [[NSUserDefaults alloc] initWithSuiteName:kDadiMeshAppGroup];
  [defaults setInteger:proxy_port forKey:@"dadimesh.proxyPort"];
  [defaults synchronize];

  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  __block int result = 1;

  [NETunnelProviderManager loadAllFromPreferencesWithCompletionHandler:^(NSArray<NETunnelProviderManager *> * _Nullable managers, NSError * _Nullable error) {
    if (error || managers.count == 0) {
      result = 2;
      dispatch_semaphore_signal(sem);
      return;
    }
    NETunnelProviderManager *manager = managers.firstObject;
    NSError *startError = nil;
    NETunnelProviderSession *session = (NETunnelProviderSession *)manager.connection;
    BOOL ok = [session startTunnelWithOptions:@{@"proxyPort": @(proxy_port)} andReturnError:&startError];
    result = (ok && startError == nil) ? 0 : 3;
    dispatch_semaphore_signal(sem);
  }];

  dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(15 * NSEC_PER_SEC)));
  return result;
}

int dadimesh_vpn_stop(void) {
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  __block int result = 0;

  [NETunnelProviderManager loadAllFromPreferencesWithCompletionHandler:^(NSArray<NETunnelProviderManager *> * _Nullable managers, NSError * _Nullable error) {
    if (!error && managers.count > 0) {
      [managers.firstObject.connection stopVPNTunnel];
    }
    dispatch_semaphore_signal(sem);
  }];

  dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(10 * NSEC_PER_SEC)));
  return result;
}
