// Spike Q4b: tap via XCTest's event synthesizer directly (what WebDriverAgent does),
// skipping XCUICoordinate's wait-for-quiescence. Private XCTest API, test runner only (never in the app).
#import <XCTest/XCTest.h>
#import <QuartzCore/QuartzCore.h>

@protocol ProbeEventPath
- (id)initForTouchAtPoint:(CGPoint)p offset:(double)o;
- (void)liftUpAtOffset:(double)o;
@end
@protocol ProbeEventRecord
- (id)initWithName:(NSString *)n interfaceOrientation:(long long)o;
- (void)addPointerEventPath:(id)path;
@end
@protocol ProbeSynth
- (BOOL)synthesizeEvent:(id)record completion:(void (^)(BOOL, NSError *))c;
@end

@interface FastTapTests : XCTestCase
@end

@implementation FastTapTests

- (NSError *)tap:(CGPoint)p {
  return [self tap:p wait:YES];
}

- (NSError *)tap:(CGPoint)p wait:(BOOL)wait {
  id<ProbeEventPath> path = [(id<ProbeEventPath>)[NSClassFromString(@"XCPointerEventPath") alloc] initForTouchAtPoint:p offset:0];
  [path liftUpAtOffset:0.02];
  id<ProbeEventRecord> rec = [(id<ProbeEventRecord>)[NSClassFromString(@"XCSynthesizedEventRecord") alloc] initWithName:@"probe tap" interfaceOrientation:1];
  [rec addPointerEventPath:path];
  id<ProbeSynth> synth = [[XCUIDevice sharedDevice] valueForKey:@"eventSynthesizer"];
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  __block NSError *err;
  [synth synthesizeEvent:rec completion:^(BOOL ok, NSError *e) { err = e; dispatch_semaphore_signal(sem); }];
  if (!wait) return nil;
  // completion arrives on a background queue; spin the run loop instead of blocking main
  while (dispatch_semaphore_wait(sem, DISPATCH_TIME_NOW)) [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.001]];
  return err;
}

- (void)testSynthesizedTapLatency {
  XCUIApplication *app = [XCUIApplication new];
  [app launch];
  XCUIElement *counter = app.buttons[@"Licznik 0"];
  XCTAssertTrue([counter waitForExistenceWithTimeout:20]);
  CGRect f = counter.frame;
  CGPoint c = CGPointMake(CGRectGetMidX(f), CGRectGetMidY(f));
  NSMutableArray<NSNumber *> *ms = [NSMutableArray array];
  for (int i = 0; i < 50; i++) {
    CFTimeInterval t = CACurrentMediaTime();
    NSError *e = [self tap:c];
    XCTAssertNil(e);
    [ms addObject:@((CACurrentMediaTime() - t) * 1000)];
  }
  BOOL delivered = [app.buttons[@"Licznik 50"] waitForExistenceWithTimeout:5];
  NSArray *s = [ms sortedArrayUsingSelector:@selector(compare:)];
  NSLog(@"PROBE_Q4B {\"synthTap\":{\"median\":%.1f,\"p95\":%.1f,\"max\":%.1f},\"all50Delivered\":%@}",
        [s[25] doubleValue], [s[47] doubleValue], [s.lastObject doubleValue], delivered ? @"true" : @"false");
  XCTAssertTrue(delivered);
}

// is ~250 ms the delivery cost or only the completion ack? fire 50 taps without waiting.
- (void)testFireAndForgetThroughput {
  XCUIApplication *app = [XCUIApplication new];
  [app launch];
  XCUIElement *counter = app.buttons[@"Licznik 0"];
  XCTAssertTrue([counter waitForExistenceWithTimeout:20]);
  CGRect f = counter.frame;
  CGPoint c = CGPointMake(CGRectGetMidX(f), CGRectGetMidY(f));
  CFTimeInterval t = CACurrentMediaTime();
  for (int i = 0; i < 50; i++) {
    [self tap:c wait:NO];
    [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
  }
  CFTimeInterval sent = (CACurrentMediaTime() - t) * 1000;
  BOOL delivered = [app.buttons[@"Licznik 50"] waitForExistenceWithTimeout:30];
  NSLog(@"PROBE_Q4C {\"sentMs\":%.0f,\"untilLicznik50Ms\":%.0f,\"delivered\":%@}", sent, (CACurrentMediaTime() - t) * 1000, delivered ? @"true" : @"false");
}

@end
