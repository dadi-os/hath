#import <CoreLocation/CoreLocation.h>
#import <Foundation/Foundation.h>
#import <TargetConditionals.h>
#import <stdio.h>
#import <string.h>

@interface HathLocationProbe : NSObject <CLLocationManagerDelegate>
@property(nonatomic, strong) CLLocationManager *manager;
@property(nonatomic, strong) CLLocation *fix;
@property(nonatomic, strong) NSError *error;
@property(nonatomic, assign) BOOL done;
@property(nonatomic, assign) BOOL authSettled;
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
  self.authSettled = YES;
}

@end

static BOOL hath_location_is_authorized(CLAuthorizationStatus status) {
#if TARGET_OS_IPHONE
  return status == kCLAuthorizationStatusAuthorizedWhenInUse ||
         status == kCLAuthorizationStatusAuthorizedAlways;
#else
  return status == kCLAuthorizationStatusAuthorizedAlways;
#endif
}

static void hath_location_request_auth(CLLocationManager *manager) {
#if TARGET_OS_IPHONE
  [manager requestWhenInUseAuthorization];
#else
  [manager requestAlwaysAuthorization];
#endif
}

/** Build a single-line address from a placemark; empty string if nothing useful. */
static NSString *hath_format_placemark(CLPlacemark *mark) {
  if (mark == nil) {
    return @"";
  }
  NSMutableArray<NSString *> *parts = [NSMutableArray new];
  if (mark.subThoroughfare.length > 0 && mark.thoroughfare.length > 0) {
    [parts addObject:[NSString stringWithFormat:@"%@ %@", mark.subThoroughfare, mark.thoroughfare]];
  } else if (mark.thoroughfare.length > 0) {
    [parts addObject:mark.thoroughfare];
  }
  if (mark.locality.length > 0) {
    [parts addObject:mark.locality];
  }
  if (mark.administrativeArea.length > 0) {
    [parts addObject:mark.administrativeArea];
  }
  if (mark.postalCode.length > 0) {
    [parts addObject:mark.postalCode];
  }
  if (mark.country.length > 0) {
    [parts addObject:mark.country];
  }
  if (parts.count == 0 && mark.name.length > 0) {
    [parts addObject:mark.name];
  }
  return [parts componentsJoinedByString:@", "];
}

/**
 * hath_location_prepare is a no-op retained for ABI stability. Authorization is
 * requested on demand in hath_device_get_location so app launches do not prompt.
 */
void hath_location_prepare(void) {}

/**
 * hath_device_get_location performs a one-shot CoreLocation read, then reverse
 * geocodes via CLGeocoder. address_out may be empty when geocode fails; coords
 * still succeed. Auth: When-In-Use on iOS, Always on macOS.
 */
int hath_device_get_location(double *lat, double *lon, double *accuracy_m, char *at_out,
                             size_t at_len, char *address_out, size_t address_len, char *err,
                             size_t err_len) {
  if (lat == NULL || lon == NULL || accuracy_m == NULL || at_out == NULL || at_len == 0 ||
      address_out == NULL || address_len == 0 || err == NULL || err_len == 0) {
    return -1;
  }
  err[0] = '\0';
  at_out[0] = '\0';
  address_out[0] = '\0';

  __block int rc = -1;
  void (^finish)(void) = ^{
    @autoreleasepool {
      HathLocationProbe *probe = [HathLocationProbe new];
      CLLocationManager *manager = [CLLocationManager new];
      probe.manager = manager;
      manager.delegate = probe;

      CLAuthorizationStatus status = manager.authorizationStatus;
      if (status == kCLAuthorizationStatusNotDetermined) {
        probe.authSettled = NO;
        hath_location_request_auth(manager);
        NSDate *authDeadline = [NSDate dateWithTimeIntervalSinceNow:20.0];
        while (!probe.authSettled && [authDeadline timeIntervalSinceNow] > 0) {
          [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                   beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
        }
        status = manager.authorizationStatus;
      }

      if (status == kCLAuthorizationStatusNotDetermined) {
        snprintf(err, err_len, "permission_denied: location permission timed out");
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

      if (probe.fix == nil) {
        if (probe.error != nil) {
          NSString *msg = probe.error.localizedDescription;
          if (msg.length == 0) {
            msg = @"location failed";
          }
          if (probe.error.code == kCLErrorDenied) {
            snprintf(err, err_len, "permission_denied: %s", msg.UTF8String);
          } else {
            snprintf(err, err_len, "internal_error: %s", msg.UTF8String);
          }
          return;
        }
        snprintf(err, err_len, "internal_error: location timed out");
        return;
      }
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
      NSString *iso = [fmt stringFromDate:probe.fix.timestamp];
      if (iso.length == 0) {
        snprintf(err, err_len, "internal_error: location timestamp unavailable");
        return;
      }
      snprintf(at_out, at_len, "%s", iso.UTF8String);

      __block NSArray<CLPlacemark *> *placemarks = nil;
      __block BOOL geoDone = NO;
      __block NSError *geoErr = nil;
      CLGeocoder *geocoder = [CLGeocoder new];
      [geocoder reverseGeocodeLocation:probe.fix
                     completionHandler:^(NSArray<CLPlacemark *> *marks, NSError *geoError) {
                       placemarks = marks;
                       geoErr = geoError;
                       geoDone = YES;
                     }];
      NSDate *geoDeadline = [NSDate dateWithTimeIntervalSinceNow:15.0];
      while (!geoDone && [geoDeadline timeIntervalSinceNow] > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                 beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
      }
      if (geoErr != nil) {
        NSLog(@"hath reverse geocode failed: %@", geoErr.localizedDescription);
      }
      NSString *address = hath_format_placemark(placemarks.firstObject);
      if (address.length > 0) {
        snprintf(address_out, address_len, "%s", address.UTF8String);
      }

      rc = 0;
    }
  };

  if ([NSThread isMainThread]) {
    finish();
  } else {
    dispatch_sync(dispatch_get_main_queue(), finish);
  }
  return rc;
}
