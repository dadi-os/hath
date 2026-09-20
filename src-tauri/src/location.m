#import <CoreLocation/CoreLocation.h>
#import <Foundation/Foundation.h>
#import <stdio.h>
#import <string.h>

@interface HathLocationProbe : NSObject <CLLocationManagerDelegate>
@property(nonatomic, strong) CLLocationManager *manager;
@property(nonatomic, strong) CLLocation *fix;
@property(nonatomic, strong) NSError *error;
@property(nonatomic, assign) BOOL done;
@end

@implementation HathLocationProbe

- (void)finishWithError:(NSError *)error {
  self.error = error;
  self.done = YES;
}

- (void)locationManager:(CLLocationManager *)manager
     didUpdateLocations:(NSArray<CLLocation *> *)locations {
  (void)manager;
  self.fix = locations.lastObject;
  self.done = YES;
}

- (void)locationManager:(CLLocationManager *)manager didFailWithError:(NSError *)error {
  (void)manager;
  [self finishWithError:error];
}

- (void)locationManagerDidChangeAuthorization:(CLLocationManager *)manager {
  (void)manager;
}

@end

static BOOL hath_location_is_authorized(CLAuthorizationStatus status) {
  return status == kCLAuthorizationStatusAuthorizedAlways;
}

/** Retained so requestAlwaysAuthorization outlives the prepare call. */
static CLLocationManager *gHathLocationPrepareManager;

/**
 * hath_location_prepare registers Hath for Location Services when status is
 * undetermined so the app appears in System Settings. Safe to call at launch;
 * does not block and does not run from agent tool paths.
 */
void hath_location_prepare(void) {
  dispatch_async(dispatch_get_main_queue(), ^{
    @autoreleasepool {
      if (gHathLocationPrepareManager == nil) {
        gHathLocationPrepareManager = [CLLocationManager new];
      }
      CLAuthorizationStatus status = gHathLocationPrepareManager.authorizationStatus;
      if (status != kCLAuthorizationStatusNotDetermined) {
        return;
      }
      [gHathLocationPrepareManager requestAlwaysAuthorization];
    }
  });
}

/**
 * hath_device_get_location performs a one-shot CoreLocation read. It does not
 * present a permission dialog — enable Location for Hath in System Settings
 * first (or accept the one-time launch prompt from hath_location_prepare).
 * On success writes lat/lon/accuracy and an ISO-8601 UTC timestamp into at_out.
 */
int hath_device_get_location(double *lat, double *lon, double *accuracy_m, char *at_out,
                             size_t at_len, char *err, size_t err_len) {
  if (lat == NULL || lon == NULL || accuracy_m == NULL || at_out == NULL || at_len == 0 ||
      err == NULL || err_len == 0) {
    return -1;
  }
  err[0] = '\0';
  at_out[0] = '\0';

  __block int rc = -1;
  void (^finish)(void) = ^{
    @autoreleasepool {
      HathLocationProbe *probe = [HathLocationProbe new];
      CLLocationManager *manager = [CLLocationManager new];
      probe.manager = manager;
      manager.delegate = probe;

      CLAuthorizationStatus status = manager.authorizationStatus;
      if (status == kCLAuthorizationStatusNotDetermined) {
        snprintf(err, err_len,
                 "permission_denied: enable Location for Hath in System Settings "
                 "(or relaunch Hath once to register)");
        return;
      }
      if (status == kCLAuthorizationStatusRestricted) {
        snprintf(err, err_len, "permission_denied: location access is restricted");
        return;
      }
      if (!hath_location_is_authorized(status)) {
        snprintf(err, err_len, "permission_denied: location access denied");
        return;
      }

      manager.desiredAccuracy = kCLLocationAccuracyHundredMeters;
      [manager requestLocation];

      NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:20.0];
      while (!probe.done && [deadline timeIntervalSinceNow] > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                 beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
      }

      if (probe.fix != nil) {
        if (probe.fix.horizontalAccuracy < 0) {
          snprintf(err, err_len, "internal_error: location fix is invalid");
          return;
        }
        *lat = probe.fix.coordinate.latitude;
        *lon = probe.fix.coordinate.longitude;
        *accuracy_m = probe.fix.horizontalAccuracy;
        NSISO8601DateFormatter *fmt = [NSISO8601DateFormatter new];
        fmt.formatOptions = NSISO8601DateFormatWithInternetDateTime;
        fmt.timeZone = [NSTimeZone timeZoneWithAbbreviation:@"UTC"];
        NSString *iso = [fmt stringFromDate:probe.fix.timestamp] ?: @"";
        snprintf(at_out, at_len, "%s", iso.UTF8String);
        rc = 0;
        return;
      }
      if (probe.error != nil) {
        NSString *msg = probe.error.localizedDescription ?: @"location failed";
        if (probe.error.code == kCLErrorDenied) {
          snprintf(err, err_len, "permission_denied: %s", msg.UTF8String);
        } else {
          snprintf(err, err_len, "internal_error: %s", msg.UTF8String);
        }
        return;
      }
      snprintf(err, err_len, "internal_error: location timed out");
    }
  };

  if ([NSThread isMainThread]) {
    finish();
  } else {
    dispatch_sync(dispatch_get_main_queue(), finish);
  }
  return rc;
}
