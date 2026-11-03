// Mantis native agent, iOS. Same contract as the Android agent (android/src/mantis/.../MantisAgent.kt); the runner is
// src/runner.
//
// Compiled in only with MANTIS_E2E=1 in the build environment (mantis.podspec defines MANTIS_E2E_$(MANTIS_E2E), so only
// that build gets MANTIS_E2E_1) and only for the simulator. Every other build compiles this file to nothing.
// Private UIKit/IOKit API (touch synthesis) must never reach the App Store: App Store binaries are device builds, and a
// device build with MANTIS_E2E=1 (e.g. the variable leaked into a release job) fails to compile instead.
//
// Passive until a runner listens: dials ws://localhost:<port> (simulators share the Mac's localhost; port: launch
// argument -mantisPort N, default 9123), retries every 2 s. Own socket, independent of the JS thread. All view work on
// the main thread. Coordinates are points (= JS units).
#import <TargetConditionals.h>
// mantis.podspec always defines exactly one MANTIS_E2E_<value>: unset gives MANTIS_E2E_, so any other value (true,
// yes, "1 ") is a typo that would silently build without the agent
#if !defined(MANTIS_E2E_) && !defined(MANTIS_E2E_0) && !defined(MANTIS_E2E_1)
#error "MANTIS_E2E must be 1 (agent) or 0/unset (no agent)"
#endif
#if defined(MANTIS_E2E_1) && !TARGET_OS_SIMULATOR
#error "MANTIS_E2E=1 in a device build: the Mantis agent is for simulator E2E builds only and must never ship"
#endif
#if defined(MANTIS_E2E_1) && TARGET_OS_SIMULATOR
#import <UIKit/UIKit.h>
#import <QuartzCore/QuartzCore.h>
#import <dlfcn.h>
#import <mach/mach_time.h>
#import <objc/runtime.h>
#import <pthread.h>

// Draw clock for Agent.ping (Android: an OnDrawListener per window). iOS has no draw callback, so two hooks on CALayer,
// installed at load. A property set to a new value on the main thread: a mount, a native-driver / Reanimated frame, a
// scroll or fling, an image landing. And addAnimation:forKey:, as UIKit transitions, UIView animations,
// react-native-screens and spinners move in the render server, where no setter fires: the screen counts as changing
// until the animation's end, and a loop (a spinner) keeps its layer for the ping to check.
static CFTimeInterval mantisChangedAt; // CACurrentMediaTime of the last change
static NSUInteger mantisChanges;
static Class mantisChangedClass; // what the last change was: its view's class and tag, the setter
static NSInteger mantisChangedTag;
static const char *mantisChangedHow;
static CFTimeInterval mantisAnimEnd; // when the last-ending animation stops
static NSString *mantisAnimWhat; // ...and what it animates
static NSHashTable<CALayer *> *mantisLoops; // weak: layers given a loop; a ping drops the ones without animations

static void mantisChanged(CALayer *l, const char *how) {
  mantisChanges++;
  mantisChangedAt = CACurrentMediaTime();
  id d = l.delegate;
  mantisChangedClass = object_getClass(d ?: l);
  mantisChangedTag = [d isKindOfClass:UIView.class] ? ((UIView *)d).tag : 0;
  mantisChangedHow = how;
}

#define MANTIS_HOOK(setter, T, same) do { \
  Method m = class_getInstanceMethod(CALayer.class, @selector(setter:)); \
  void (*orig)(CALayer *, SEL, T) = (void *)method_getImplementation(m); \
  method_setImplementation(m, imp_implementationWithBlock(^(CALayer *l, T v) { \
    if (pthread_main_np() && !(same)) mantisChanged(l, #setter); \
    orig(l, @selector(setter:), v); \
  })); \
} while (0)

// Seconds an animation moves: 0 for one that never progresses (infinite duration: iOS 26's keyboard glass layers
// that follow another layer), more than a minute for a loop (a spinner, a text cursor).
static double mantisActive(CAAnimation *a) {
  if (isinf(a.duration)) return 0;
  if (a.repeatDuration > 0) return a.repeatDuration;
  return (a.duration ?: 0.25) * MAX(a.repeatCount, 1) * (a.autoreverses ? 2 : 1);
}

// The keyboard's windows don't count: its bar's labels morph for a second after each field, and the keyboard is
// another process's, as on Android (snapshot already reports its end frame)
static BOOL mantisKeyboardLayer(CALayer *l) {
  for (; l; l = l.superlayer)
    if ([l.delegate isKindOfClass:UIWindow.class]) {
      NSString *w = NSStringFromClass([l.delegate class]);
      return [w containsString:@"Keyboard"] || [w containsString:@"TextEffects"];
    }
  return NO;
}

static void mantisHookLayers(void) {
  mantisChangedAt = CACurrentMediaTime();
  mantisLoops = [NSHashTable weakObjectsHashTable];
  MANTIS_HOOK(setPosition, CGPoint, CGPointEqualToPoint(l.position, v));
  MANTIS_HOOK(setBounds, CGRect, CGRectEqualToRect(l.bounds, v));
  MANTIS_HOOK(setTransform, CATransform3D, CATransform3DEqualToTransform(l.transform, v));
  MANTIS_HOOK(setOpacity, float, l.opacity == v);
  MANTIS_HOOK(setContents, id, l.contents == v);
  Method m = class_getInstanceMethod(CALayer.class, @selector(addAnimation:forKey:));
  void (*orig)(CALayer *, SEL, CAAnimation *, NSString *) = (void *)method_getImplementation(m);
  method_setImplementation(m, imp_implementationWithBlock(^(CALayer *l, CAAnimation *a, NSString *k) {
    if (pthread_main_np() && !mantisKeyboardLayer(l)) {
      mantisChanged(l, "addAnimation");
      CFTimeInterval now = mantisChangedAt;
      double active = mantisActive(a);
      // beginTime: 0 = now, else in the layer's time (UIKit's delay)
      CFTimeInterval end = (a.beginTime > 0 ? now + a.beginTime - [l convertTime:now fromLayer:nil] : now) + active;
      if (active > 60) [mantisLoops addObject:l];
      else if (end > mantisAnimEnd) {
        mantisAnimEnd = end;
        mantisAnimWhat = [NSString stringWithFormat:@"%@ animating %@", NSStringFromClass([(l.delegate ?: l) class]), k];
      }
    }
    orig(l, @selector(addAnimation:forKey:), a, k);
  }));
}

// A loop on screen: in a window, not hidden, and not a text cursor (a focused input's caret blinks forever; Android's
// blink draws are 500 ms apart, so they never hold the idle wait either)
static BOOL mantisLoopShown(CALayer *l) {
  for (; l; l = l.superlayer) {
    if (l.hidden || [l.delegate conformsToProtocol:@protocol(UITextInput)]) return NO;
    if ([l.delegate isKindOfClass:UIWindow.class]) return YES;
  }
  return NO;
}

static UITouch *_touch; // synthesized finger between Began and Ended/Cancelled; nil = no gesture in progress
static NSUInteger _gestureId; // bumped by every gesture, so callbacks of an earlier one can tell they're stale

// Every callback that answers an RPC runs through this: an exception (private API changed, view gone, ...) becomes the
// RPC's error instead of killing the app and with it the whole E2E session.
static void MantisGuard(void (^done)(id), void (^body)(void)) {
  @try { body(); } @catch (NSException *e) { done(e); }
}

// RN component views (Fabric, all RCTViewComponentView subclasses): their tag is the React tag. Any other view may set
// tag too (plain UIKit API), so only these count. nil protocol (renamed in some RN version): every view counts.
static BOOL isRN(UIView *v) {
  static Protocol *proto;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ proto = NSProtocolFromString(@"RCTComponentViewProtocol"); });
  return !proto || [v conformsToProtocol:proto];
}

// CADisplayLink target that runs a block (the link retains it; invalidating the link frees both)
@interface MantisBlockTarget : NSObject
@property (nonatomic, copy) void (^block)(void);
@end
@implementation MantisBlockTarget
+ (instancetype)withBlock:(void (^)(void))b { MantisBlockTarget *t = [self new]; t.block = b; return t; }
- (void)fire { _block(); }
@end

// first responder, found the usual way: an action sent to nil goes down the responder chain
static __weak UIResponder *mantisFR;
@implementation UIResponder (MantisFirstResponder)
- (void)mantis_captureFirstResponder:(id)sender { mantisFR = self; }
@end
// The deepest shown navigation controller with more than one screen (tab → selected, navigation → top, containers →
// their shown children, last first), or nil: what a back button would pop.
static UINavigationController *backStack(UIViewController *vc) {
  NSArray<UIViewController *> *next = [vc isKindOfClass:UITabBarController.class] ? @[((UITabBarController *)vc).selectedViewController ?: vc]
    : [vc isKindOfClass:UINavigationController.class] ? @[((UINavigationController *)vc).topViewController ?: vc]
    : vc.childViewControllers.reverseObjectEnumerator.allObjects;
  for (UIViewController *c in next) {
    if (c == vc || !c.isViewLoaded || !c.view.window || c.view.isHidden) continue;
    UINavigationController *deeper = backStack(c);
    if (deeper) return deeper;
  }
  return [vc isKindOfClass:UINavigationController.class] && ((UINavigationController *)vc).viewControllers.count > 1 ? (UINavigationController *)vc : nil;
}

static UIResponder *MantisFirstResponder(void) {
  mantisFR = nil;
  [UIApplication.sharedApplication sendAction:@selector(mantis_captureFirstResponder:) to:nil from:nil forEvent:nil];
  return mantisFR;
}

@interface MantisAgent : NSObject
- (void)synth:(UITouchPhase)phase at:(CGPoint)p;
@end

static NSException *MantisError(NSString *reason) {
  return [NSException exceptionWithName:@"MantisAgent" reason:reason userInfo:nil];
}

@implementation MantisAgent {
  NSURLSessionWebSocketTask *_ws;
  CGRect _keyboard; // last keyboard end frame (UIKeyboardWillChangeFrame), screen points; off screen = none
}

static MantisAgent *shared;

+ (void)load {
  // app extensions and logic test bundles load this binary too (use_frameworks!): no UIApplication there
  if (![NSBundle.mainBundle.bundlePath hasSuffix:@".app"]) return;
  mantisHookLayers();
  dispatch_async(dispatch_get_main_queue(), ^{
    shared = [MantisAgent new];
    [NSNotificationCenter.defaultCenter addObserverForName:UIKeyboardWillChangeFrameNotification object:nil queue:nil
                                                usingBlock:^(NSNotification *n) {
      shared->_keyboard = [n.userInfo[UIKeyboardFrameEndUserInfoKey] CGRectValue];
    }];
    [NSNotificationCenter.defaultCenter addObserverForName:UIKeyboardWillHideNotification object:nil queue:nil
                                                usingBlock:^(NSNotification *n) { shared->_keyboard = CGRectNull; }];
    [shared connect];
  });
}

- (void)connect {
  // launch arguments only (-mantisPort N -mantisToken T), not values the app may have persisted under the same keys
  NSDictionary *args = [NSUserDefaults.standardUserDefaults volatileDomainForName:NSArgumentDomain];
  NSInteger port = [args[@"mantisPort"] integerValue] ?: 9123;
  id token = [args[@"mantisToken"] isKindOfClass:NSString.class] ? args[@"mantisToken"] : NSNull.null;
  NSString *url = [NSString stringWithFormat:@"ws://localhost:%ld/?role=native", (long)port];
  _ws = [NSURLSession.sharedSession webSocketTaskWithURL:[NSURL URLWithString:url]];
  [_ws resume];
  // v: src/runner PROTOCOL; token: proves to the runner that it launched this app (simulators share localhost)
  [self send:@{@"method": @"Agent.hello", @"params": @{@"role": @"native", @"platform": @"ios", @"v": @2, @"token": token}}];
  [self receive];
}

- (void)send:(NSDictionary *)msg {
  NSData *d = [NSJSONSerialization dataWithJSONObject:msg options:0 error:nil];
  [_ws sendMessage:[[NSURLSessionWebSocketMessage alloc] initWithString:[[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding]]
 completionHandler:^(NSError *e) {}];
}

- (void)receive {
  NSURLSessionWebSocketTask *ws = _ws;
  [ws receiveMessageWithCompletionHandler:^(NSURLSessionWebSocketMessage *m, NSError *err) {
    if (err) {
      // 2 s, not less: Detox iOS (DetoxSync) tracks main-queue dispatch_after up to 1.5 s as "app busy", so a faster
      // loop would stall Detox runs of the same build
      [ws cancel];
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        if (ws == self->_ws) [self connect];
      });
      return;
    }
    // validate before use: a binary / non-JSON / id-less frame has nothing to answer
    id msg = m.type == NSURLSessionWebSocketMessageTypeString
      ? [NSJSONSerialization JSONObjectWithData:[m.string dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil] : nil;
    id mid = [msg isKindOfClass:NSDictionary.class] ? msg[@"id"] : nil;
    if (![mid isKindOfClass:NSNumber.class]) {
      NSLog(@"[Mantis] ignoring a frame that is not an RPC request");
      [self receive];
      return;
    }
    id method = msg[@"method"], params = msg[@"params"];
    dispatch_async(dispatch_get_main_queue(), ^{
      // exactly one reply per request, whatever path (sync, async callback, exception) gets there first
      __block BOOL replied = NO;
      void (^done)(id) = ^(id result) {
        if (replied) return;
        replied = YES;
        NSDictionary *out = [result isKindOfClass:NSException.class]
          ? @{@"id": mid, @"error": @{@"message": [NSString stringWithFormat:@"%@: %@", [result name], [result reason]]}}
          : @{@"id": mid, @"result": result ?: NSNull.null};
        if (![NSJSONSerialization isValidJSONObject:out]) // NaN / inf would make NSJSONSerialization throw
          out = @{@"id": mid, @"error": @{@"message": [NSString stringWithFormat:@"%@: result not JSON-serializable", method]}};
        [self send:out];
      };
      MantisGuard(done, ^{
        if (![method isKindOfClass:NSString.class]) [NSException raise:@"MantisAgent" format:@"no method"];
        [self handle:method params:[params isKindOfClass:NSDictionary.class] ? params : @{} done:done];
      });
    });
    [self receive];
  }];
}

// All visible windows of this process, topmost first. RN Modal = a presented view controller in the same window;
// alerts / keyboard host / text effects are own windows. Coordinates: window == screen (full-screen windows).
- (NSArray<UIWindow *> *)windows {
  NSMutableArray<UIWindow *> *all = [NSMutableArray array];
  for (UIScene *s in UIApplication.sharedApplication.connectedScenes)
    if ([s isKindOfClass:UIWindowScene.class])
      for (UIWindow *w in ((UIWindowScene *)s).windows.reverseObjectEnumerator) if (!w.isHidden) [all addObject:w];
  [all sortWithOptions:NSSortStable usingComparator:^(UIWindow *a, UIWindow *b) { return [@(b.windowLevel) compare:@(a.windowLevel)]; }];
  return all;
}

static UIView *findTagged(UIView *v, NSInteger tag) {
  if (v.tag == tag && isRN(v)) return v;
  for (UIView *c in v.subviews) { UIView *f = findTagged(c, tag); if (f) return f; }
  return nil;
}

- (UIView *)viewForTag:(NSInteger)tag {
  if (tag <= 0) return nil;
  for (UIWindow *w in self.windows) { UIView *v = findTagged(w, tag); if (v) return v; }
  return nil;
}

// like Android View.isShown: attached to a window and no hidden ancestor (alpha doesn't count, as on Android)
static BOOL shown(UIView *v) {
  if (!v.window) return NO;
  for (; v; v = v.superview) if (v.isHidden) return NO;
  return YES;
}

// UIKit hit-testing skips views with alpha < 0.01 (Android doesn't), e.g. the hidden TextInput of an OTP field
static BOOL transparent(UIView *v) {
  for (; v; v = v.superview) if (v.alpha < 0.01) return YES;
  return NO;
}

static UIView *textInputIn(UIView *v) {
  if ([v conformsToProtocol:@protocol(UITextInput)]) return v;
  for (UIView *c in v.subviews) { UIView *t = textInputIn(c); if (t) return t; }
  return nil;
}

static NSDictionary *R(CGRect r) {
  return @{@"x": @(r.origin.x), @"y": @(r.origin.y), @"width": @(r.size.width), @"height": @(r.size.height)};
}

// presentation layer = what is on screen right now, incl. native-driver / Core Animation in flight
static CGRect presentedRect(UIView *v) {
  CALayer *p = v.layer.presentationLayer ?: v.layer;
  CALayer *wl = v.window.layer;
  CGRect r = [p convertRect:p.bounds toLayer:(wl.presentationLayer ?: wl)];
  return CGRectOffset(r, v.window.frame.origin.x, v.window.frame.origin.y);
}

// Part of the screen where v can be seen: its window clipped by every scroll view ancestor (Android: viewport()).
static CGRect viewport(UIView *v) {
  CGRect clip = v.window.frame;
  for (UIView *a = v.superview; a; a = a.superview)
    if ([a isKindOfClass:UIScrollView.class]) clip = CGRectIntersection(clip, presentedRect(a));
  return clip;
}

// Visible share of the view: its rect clipped by the screen and every clipping ancestor (clipsToBounds, scroll
// views). ponytail: Detox iOS also renders the window to find views covered by siblings; this doesn't.
static double visibleRatio(UIView *v) {
  if (!v || !shown(v) || transparent(v)) return 0;
  CGRect r = presentedRect(v);
  double area = r.size.width * r.size.height;
  if (area <= 0) return 0;
  CGRect vis = CGRectIntersection(r, UIScreen.mainScreen.bounds);
  for (UIView *a = v.superview; a && !CGRectIsNull(vis); a = a.superview)
    if (a.clipsToBounds || [a isKindOfClass:UIScrollView.class]) vis = CGRectIntersection(vis, presentedRect(a));
  return CGRectIsNull(vis) ? 0 : vis.size.width * vis.size.height / area;
}

static UIScrollView *nearestScroller(UIView *v) {
  for (UIView *a = v.superview; a; a = a.superview) if ([a isKindOfClass:UIScrollView.class]) return (UIScrollView *)a;
  return nil;
}

// RN's tagged RCTScrollViewComponentView wraps the actual UIScrollView
static UIScrollView *scrollViewIn(UIView *v) {
  if ([v isKindOfClass:UIScrollView.class]) return (UIScrollView *)v;
  for (UIView *c in v.subviews) if ([c isKindOfClass:UIScrollView.class]) return (UIScrollView *)c;
  return nil;
}

static BOOL sameRect(CGRect a, CGRect b) { // any sub-point change = still moving
  return fabs(a.origin.x - b.origin.x) < 0.01 && fabs(a.origin.y - b.origin.y) < 0.01 &&
         fabs(a.size.width - b.size.width) < 0.01 && fabs(a.size.height - b.size.height) < 0.01;
}

static NSArray *tagChain(UIView *v) {
  NSMutableArray *a = [NSMutableArray array];
  for (; v; v = v.superview) if (v.tag > 0 && isRN(v)) [a addObject:@(v.tag)];
  return a;
}

// Where a real finger would land: UIKit hit-test (what RN's touch handler and UIControls use) in the topmost
// window that takes the point; the keyboard host window counts as an overlay like any other.
- (UIView *)hitView:(CGPoint)p {
  for (UIWindow *w in self.windows) {
    UIView *hit = [w hitTest:CGPointMake(p.x - w.frame.origin.x, p.y - w.frame.origin.y) withEvent:nil];
    if (hit) return hit;
  }
  return nil;
}

- (NSDictionary *)hitTest:(CGPoint)p {
  UIView *hit = [self hitView:p];
  NSString *window = NSStringFromClass(hit.window.class) ?: @"";
  NSMutableDictionary *out = [@{@"tag": @(hit.tag), @"class": NSStringFromClass(hit.class) ?: @"", @"window": window,
                                @"chain": tagChain(hit)} mutableCopy];
  if ([window containsString:@"Keyboard"] || [window containsString:@"TextEffects"]) out[@"covered"] = @"keyboard";
  return out;
}

// Android reaches(): a touch at the centre of v's visible part lands in v, in a view inside v, or in an ancestor of v (a
// text in a pressable), or in a view of the same window that, with every superview below the common ancestor, doesn't
// cover all of v (a sibling over a corner; not a QR code in a sheet over v, nor a text in a Modal: the sheet or the
// Modal's root takes the rest). ponytail: a pointerEvents box-none wrapper on that path still counts as covering.
- (BOOL)reaches:(UIView *)v {
  if (!v) return NO;
  CGRect vis = CGRectIntersection(presentedRect(v), UIScreen.mainScreen.bounds);
  for (UIView *a = v.superview; a && !CGRectIsNull(vis); a = a.superview)
    if (a.clipsToBounds || [a isKindOfClass:UIScrollView.class]) vis = CGRectIntersection(vis, presentedRect(a));
  if (CGRectIsNull(vis)) return NO;
  UIView *hit = [self hitView:CGPointMake(CGRectGetMidX(vis), CGRectGetMidY(vis))];
  NSArray *chain = tagChain(hit);
  if ([chain containsObject:@(v.tag)]) return YES;
  if (chain.count && [tagChain(v) containsObject:chain.firstObject]) return YES;
  if (!hit || hit.window != v.window) return NO;
  for (UIView *a = hit; a && ![v isDescendantOfView:a]; a = a.superview)
    if (CGRectContainsRect(presentedRect(a), vis)) return NO;
  return YES;
}

// iOS counterpart of Android's "window has focus": UIKit drops touches while a view controller is being
// presented / dismissed (RN Modal), and the presented view may still move.
static NSString *transitionReason(UIWindow *w) {
  for (UIViewController *vc = w.rootViewController; vc; vc = vc.presentedViewController)
    if (vc.isBeingPresented || vc.isBeingDismissed) return @"view controller transition";
  return nil;
}

// Run block after n display frames (vsync-aligned, unlike a timer); an exception in it answers the RPC (done).
- (void)afterFrames:(int)n done:(void (^)(id))done do:(void (^)(void))block {
  __block int left = n;
  __block CADisplayLink *link = [CADisplayLink displayLinkWithTarget:[MantisBlockTarget withBlock:^{
    if (--left > 0) return;
    [link invalidate];
    link = nil;
    MantisGuard(done, block);
  }] selector:@selector(fire)];
  [link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
  // the display link stops while the app is in the background: answer instead of never. 2 s: DetoxSync counts
  // main-queue dispatch_after up to 1.5 s as "app busy"
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    if (!link) return;
    [link invalidate];
    link = nil;
    done(MantisError(@"no display frame for 2 s (app in the background?)"));
  });
}

// Finger down at p (screen points). One gesture at a time. The returned done ends the RPC: on an error, or when the
// gesture is still down after 10 s (display link stopped: app in the background), it cancels the touch first, so UIKit
// never keeps a stale finger that turns the next tap into a two-finger gesture. 10 s: a scroll is ~10 frames, seconds
// on a starved CI machine, and it must fire before the runner's 15 s RPC timeout.
- (void (^)(id))fingerDown:(CGPoint)p done:(void (^)(id))done {
  if (_touch) [NSException raise:@"MantisAgent" format:@"another gesture is in progress (actions on one app run one at a time)"];
  NSUInteger gid = ++_gestureId;
  void (^end)(id) = ^(id r) {
    if (gid == _gestureId && _touch) [self cancelTouch];
    done(r);
  };
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    end(MantisError(@"gesture still down after 10 s, cancelled"));
  });
  @try { [self synth:UITouchPhaseBegan at:p]; } @catch (NSException *e) { end(e); @throw; }
  return end;
}

// Lifts the finger with Cancelled instead of Ended: UIKit and RN drop the gesture. Never throws.
- (void)cancelTouch {
  @try {
    CGPoint p = [_touch locationInView:nil];
    CGPoint o = _touch.window.frame.origin;
    [self synth:UITouchPhaseCancelled at:CGPointMake(p.x + o.x, p.y + o.y)];
  } @catch (NSException *ignored) {}
  _touch = nil;
}

- (void)handle:(NSString *)method params:(NSDictionary *)p done:(void (^)(id))done {
  if ([method isEqualToString:@"Layout.visibility"]) {
    // visible share per tag, for toBeInViewport and filter({ visible }); shown = in a window and not hidden
    NSMutableArray *ratios = [NSMutableArray array], *shownOut = [NSMutableArray array];
    for (id t in p[@"tags"]) {
      UIView *v = [t isKindOfClass:NSNumber.class] ? [self viewForTag:[t integerValue]] : nil;
      [ratios addObject:@(visibleRatio(v))];
      [shownOut addObject:@(v && shown(v))];
    }
    if (![p[@"hit"] boolValue]) return done(@{@"ratios": ratios, @"shown": shownOut});
    // hit: true (App.snapshot), as on Android: per tag whether a touch at the centre of its visible part reaches it, and
    // once focused (app active, no UIAlertController on top: a system alert makes the app inactive), keyboard (frame
    // from UIKeyboardWillChangeFrame, screen points, or null) and screen size. Points = dp, density = scale.
    NSMutableArray *hits = [NSMutableArray array];
    NSArray *tags = p[@"tags"];
    for (NSUInteger i = 0; i < tags.count; i++) {
      UIView *v = [tags[i] isKindOfClass:NSNumber.class] ? [self viewForTag:[tags[i] integerValue]] : nil;
      [hits addObject:[ratios[i] doubleValue] > 0 && [self reaches:v] ? @YES : @NO];
    }
    UIViewController *top = self.windows.firstObject.rootViewController;
    for (UIWindow *w in self.windows) if (w.isKeyWindow) top = w.rootViewController;
    while (top.presentedViewController) top = top.presentedViewController;
    BOOL focused = UIApplication.sharedApplication.applicationState == UIApplicationStateActive && ![top isKindOfClass:UIAlertController.class];
    CGRect screen = UIScreen.mainScreen.bounds;
    CGRect kb = CGRectIntersection(_keyboard, screen);
    // appState (UIApplicationState: 0 active, 1 inactive = a system alert / Control Center / the lock screen over it, 2 background),
    // why focused is false: an alert of the app's own or the system's, or a screen that is off.
    done(@{@"ratios": ratios, @"shown": shownOut, @"hit": hits, @"focused": @(focused),
           @"appState": @(UIApplication.sharedApplication.applicationState), @"top": NSStringFromClass(top.class) ?: NSNull.null,
           @"keyboard": CGRectIsNull(kb) || kb.size.height < 1 ? NSNull.null : R(kb),
           @"screen": @{@"width": @(screen.size.width), @"height": @(screen.size.height), @"density": @(UIScreen.mainScreen.scale)}});
  } else if ([method isEqualToString:@"Action.check"]) {
    // Actionability, native half: mounted, stable over 2 frames, in viewport (not clipped by a scroll view; delta
    // tells the runner where to scroll), no VC transition, hit-test reaches it.
    UIView *v = [self viewForTag:[p[@"tag"] integerValue]];
    NSSet *tags = [NSSet setWithArray:p[@"tags"]];
    if (!v || !shown(v)) return done(@{@"ok": @NO, @"reason": @"not mounted natively"});
    CGRect r1 = presentedRect(v);
    // 2 vsyncs: RN's native-driver display link has stepped at least once in between, whatever the callback order
    [self afterFrames:2 done:done do:^{
      if (!shown(v)) return done(@{@"ok": @NO, @"reason": @"not mounted natively"});
      CGRect r2 = presentedRect(v);
      if (!sameRect(r1, r2)) return done(@{@"ok": @NO, @"reason": @"not stable", @"r1": R(r1), @"r2": R(r2)});
      CGPoint c = CGPointMake(CGRectGetMidX(r2), CGRectGetMidY(r2));
      if (!CGRectContainsPoint(viewport(v), c)) {
        UIScrollView *sv = nearestScroller(v);
        CGRect svVisible = sv ? CGRectIntersection(viewport(sv), presentedRect(sv)) : CGRectNull;
        // the scroller itself off screen (nested in another one): no delta to give (CGRectNull's mid is inf)
        CGFloat delta = CGRectIsNull(svVisible) ? 0 : c.y - CGRectGetMidY(svVisible);
        return done(@{@"ok": @NO, @"reason": @"not in viewport", @"rect": R(r2), @"delta": @(delta)});
      }
      NSString *busy = transitionReason(v.window);
      if (busy) return done(@{@"ok": @NO, @"reason": busy});
      // no finger can reach it; the runner may focus a text input directly instead (fill)
      if (transparent(v)) return done(@{@"ok": @NO, @"reason": @"transparent", @"focusable": @(textInputIn(v) != nil)});
      NSDictionary *hit = [self hitTest:c];
      BOOL receives = NO;
      for (NSNumber *t in hit[@"chain"]) if ([tags containsObject:t]) receives = YES;
      done(@{@"ok": @(receives), @"point": @{@"x": @(c.x), @"y": @(c.y)}, @"rect": R(r2), @"hit": hit,
             @"reason": receives ? [NSNull null] : [NSString stringWithFormat:@"covered by %@ (tag %@) in %@ at (%.1f, %.1f)",
                                                    hit[@"class"], hit[@"tag"], hit[@"window"], c.x, c.y]});
    }];
  } else if ([method isEqualToString:@"Input.tap"]) {
    // finger down, held 30 ms, then up. 1 frame is 8 ms at 120 Hz and iOS 26 UISwitch then misses the tap (spike:
    // 1 frame 2/6 toggles, >= 16 ms 12/12), so hold for time, not frames.
    CGPoint pt = CGPointMake([p[@"x"] doubleValue], [p[@"y"] doubleValue]);
    void (^end)(id) = [self fingerDown:pt done:done];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
      MantisGuard(end, ^{
        [self synth:UITouchPhaseEnded at:pt];
        end(@{@"ok": @YES});
      });
    });
  } else if ([method isEqualToString:@"Input.scroll"]) {
    // Scroll = a real drag on the scroll view, same recipe as Android: down, eased moves (one per frame), finger held
    // still (moves at the end point) for > 100 ms so the release velocity is 0 (no deceleration), up.
    // dy (pt) = how far content should move up (positive = reveal content below).
    UIView *host = [self viewForTag:[p[@"tag"] integerValue]];
    UIScrollView *sv = scrollViewIn(host);
    // JS commit can be ~1 frame ahead of the native mount: not ready yet, the runner retries next frame
    if (!sv || !shown(sv)) return done(@{@"ok": @NO, @"reason": @"scroll view not mounted natively"});
    CGRect vp = CGRectIntersection(viewport(sv), presentedRect(sv));
    if (CGRectIsEmpty(vp)) return done(@{@"ok": @NO, @"reason": @"scroll view not on screen"});
    const CGFloat slop = 10; // UIPanGestureRecognizer hysteresis
    double want = [p[@"dy"] doubleValue];
    // dy 0 would put down and up on one point: a tap on whatever is under it
    if (want == 0) return done(@{@"ok": @NO, @"reason": @"dy is 0, nothing to scroll"});
    CGPoint startOffset = sv.contentOffset;
    double amount = MIN(fabs(want) + slop, vp.size.height * 0.8) * (want < 0 ? -1 : 1);
    CGPoint a = CGPointMake(CGRectGetMidX(vp), CGRectGetMidY(vp) + amount / 2);
    CGPoint b = CGPointMake(a.x, CGRectGetMidY(vp) - amount / 2);
    if (![tagChain([self hitView:a]) containsObject:@(host.tag)])
      return done(@{@"ok": @NO, @"reason": @"scroll view covered at start point"});
    void (^end)(id) = [self fingerDown:a done:done];
    NSUInteger gid = _gestureId;
    int moves = MAX([p[@"moves"] intValue], 0) ?: 6;
    __block int frame = 0;
    __block CFTimeInterval lastMove = CACurrentMediaTime();
    __block CADisplayLink *link = [CADisplayLink displayLinkWithTarget:[MantisBlockTarget withBlock:^{
      // cancelled (error, watchdog): stop
      if (gid != _gestureId || !_touch) {
        [link invalidate];
        link = nil;
        return;
      }
      MantisGuard(end, ^{
        frame++;
        CFTimeInterval now = CACurrentMediaTime();
        if (frame <= moves) {
          double k = 1 - (1 - (double)frame / moves) * (1 - (double)frame / moves); // ease-out
          [self synth:UITouchPhaseMoved at:CGPointMake(a.x, a.y + (b.y - a.y) * k)];
          lastMove = now;
        } else if (now - lastMove < 0.11) {
          [self synth:UITouchPhaseMoved at:b];
        } else {
          [link invalidate];
          link = nil;
          [self synth:UITouchPhaseEnded at:b];
          // 2 frames: lets the scroll events of the release reach the JS queue before the runner queries again
          // moved: NO = the drag happened but the content didn't move (at its end), the runner stops scrolling
          [self afterFrames:2 done:end do:^{
            end(@{@"ok": @YES, @"pt": @(amount), @"moved": @(!CGPointEqualToPoint(startOffset, sv.contentOffset))});
          }];
        }
      });
    }] selector:@selector(fire)];
    [link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
  } else if ([method isEqualToString:@"Input.scrollToEdge"]) {
    // Detox scrollTo(edge): jump the scroll view to its start/end (programmatic, like Detox's edge scroll)
    UIScrollView *sv = scrollViewIn([self viewForTag:[p[@"tag"] integerValue]]);
    if (!sv) return done(@{@"ok": @NO, @"reason": @"not a scroll view"});
    UIEdgeInsets in = sv.adjustedContentInset;
    NSString *edge = p[@"edge"];
    CGPoint o = CGPointMake(-in.left, -in.top);
    if ([edge isEqualToString:@"bottom"]) o.y = MAX(o.y, sv.contentSize.height + in.bottom - sv.bounds.size.height);
    if ([edge isEqualToString:@"right"]) o.x = MAX(o.x, sv.contentSize.width + in.right - sv.bounds.size.width);
    [sv setContentOffset:o animated:NO];
    // 2 frames, like Input.scroll: the scroll events reach the JS queue before the runner queries again
    [self afterFrames:2 done:done do:^{ done(@{@"ok": @YES}); }];
  } else if ([method isEqualToString:@"Input.typeText"]) {
    // Text through UITextInput on the first responder (the keyboard's own path: insertText:), not by setting props.
    // replace = select all first (Playwright fill).
    UIResponder *fr = MantisFirstResponder();
    if (![fr conformsToProtocol:@protocol(UITextInput)] || ![fr isKindOfClass:UIView.class])
      return done(@{@"ok": @NO, @"reason": [@"focused: " stringByAppendingString:fr ? NSStringFromClass(fr.class) : @"nothing"]});
    NSNumber *ftag = tagChain((UIView *)fr).firstObject ?: @0; // RCTUITextField sits inside the tagged component view
    NSArray *want = p[@"tags"];
    if (want && ![want containsObject:ftag])
      return done(@{@"ok": @NO, @"reason": [NSString stringWithFormat:@"focus still on tag %@", ftag]});
    id<UITextInput> ti = (id<UITextInput>)fr;
    if ([p[@"replace"] boolValue]) ti.selectedTextRange = [ti textRangeFromPosition:ti.beginningOfDocument toPosition:ti.endOfDocument];
    [ti insertText:p[@"text"]];
    done(@{@"ok": @YES, @"focusedTag": ftag});
  } else if ([method isEqualToString:@"Input.focus"]) {
    // fill on a text input no tap can reach (see transparent): focus it the way a tap would
    UIView *t = textInputIn([self viewForTag:[p[@"tag"] integerValue]]);
    done(@{@"ok": @([t becomeFirstResponder])});
  } else if ([method isEqualToString:@"Page.screenshot"]) {
    // The app's own windows, bottom-up, as PNG base64: a screenshot without XCTest. No system UI: status bar, alerts,
    // the Control Center are not the app's. scale: px per point (default 1).
    // A window drawViewHierarchy cannot draw (it returns NO; seen as black frames on a physical iPhone) is drawn by
    // layer.renderInContext instead: works off screen, but misdraws transformed text (tab bar labels) and has no
    // blur/video/Metal content. render: renderInContext only. `fallbacks`: windows drawn that way.
    CGRect screen = UIScreen.mainScreen.bounds;
    UIGraphicsImageRendererFormat *f = [UIGraphicsImageRendererFormat preferredFormat];
    f.scale = [p[@"scale"] doubleValue] > 0 ? [p[@"scale"] doubleValue] : 1;
    f.opaque = YES;
    BOOL render = [p[@"render"] boolValue], after = [p[@"afterUpdates"] boolValue];
    __block int fallbacks = 0;
    NSMutableArray *drawn = [NSMutableArray array];
    UIImage *img = [[[UIGraphicsImageRenderer alloc] initWithSize:screen.size format:f] imageWithActions:^(UIGraphicsImageRendererContext *ctx) {
      [UIColor.blackColor setFill];
      [ctx fillRect:screen];
      for (UIWindow *w in self.windows.reverseObjectEnumerator) {
        // The keyboard's windows (UIRemoteKeyboardWindow, UITextEffectsWindow) stay after the first text entry and draw
        // as an opaque black screen: the keyboard is another process. ponytail: no keyboard on the picture.
        NSString *cls = NSStringFromClass(w.class);
        if ([cls containsString:@"Keyboard"] || [cls containsString:@"TextEffects"]) continue;
        [drawn addObject:cls];
        if (!render && [w drawViewHierarchyInRect:w.frame afterScreenUpdates:after]) continue;
        if (!render) fallbacks++;
        CGContextSaveGState(ctx.CGContext);
        CGContextTranslateCTM(ctx.CGContext, w.frame.origin.x, w.frame.origin.y);
        [w.layer renderInContext:ctx.CGContext];
        CGContextRestoreGState(ctx.CGContext);
      }
    }];
    done(@{@"ok": @YES, @"fallbacks": @(fallbacks), @"windows": drawn, @"png": [UIImagePNGRepresentation(img) base64EncodedStringWithOptions:0]});
  } else if ([method isEqualToString:@"Input.back"]) {
    // The back button, in-process, as Input.back on Android: pops the topmost navigation controller that can go back (a
    // native stack: the pop its back button or edge swipe does). iOS has no system back: a JS stack (@react-navigation/stack)
    // or a presented RN Modal has no such controller (ok: false). ok: false also when the app is not active (a system
    // alert over it) or the keyboard is up; the caller does it another way then.
    if (UIApplication.sharedApplication.applicationState != UIApplicationStateActive)
      return done(@{@"ok": @NO, @"reason": @"app not active (a system alert or another app in front)"});
    CGRect kb = CGRectIntersection(_keyboard, UIScreen.mainScreen.bounds);
    if (!CGRectIsNull(kb) && kb.size.height >= 1) return done(@{@"ok": @NO, @"reason": @"keyboard on screen"});
    UIViewController *top = self.windows.firstObject.rootViewController;
    for (UIWindow *w in self.windows) if (w.isKeyWindow) top = w.rootViewController;
    while (top.presentedViewController) top = top.presentedViewController;
    if ([top isKindOfClass:UIAlertController.class]) return done(@{@"ok": @NO, @"reason": @"an alert of the app"});
    UINavigationController *nav = backStack(top);
    if (!nav) return done(@{@"ok": @NO, @"reason": @"no native navigation stack to pop"});
    // a pop during a push or pop leaves the stack and its bar out of step; ok: false, back again once it is over
    if (nav.transitionCoordinator) return done(@{@"ok": @NO, @"reason": @"a navigation transition is in progress"});
    [nav popViewControllerAnimated:YES];
    done(@{@"ok": @YES, @"via": @"navigation", @"controller": NSStringFromClass(nav.class)});
  } else if ([method isEqualToString:@"Agent.ping"]) {
    // Draw clock for the runner's idle wait, as on Android: idleMs = ms since something in the app's windows last
    // changed on screen, draws = how many changes so far. busy, for the runner's error: the animation still running,
    // else the last change (its view's class and React tag, the setter).
    CFTimeInterval now = CACurrentMediaTime(), last = MAX(mantisChangedAt, MIN(mantisAnimEnd, now));
    NSString *busy = mantisAnimEnd > now ? mantisAnimWhat : nil;
    for (CALayer *l in mantisLoops.allObjects) {
      NSArray<NSString *> *keys = l.animationKeys;
      if (!keys.count) [mantisLoops removeObject:l];
      else if (mantisLoopShown(l))
        for (NSString *k in keys)
          if (mantisActive([l animationForKey:k]) > 60) {
            last = now;
            busy = busy ?: [NSString stringWithFormat:@"%@ animating %@ in a loop", NSStringFromClass([(l.delegate ?: l) class]), k];
          }
    }
    busy = busy ?: [NSString stringWithFormat:@"%@ tag %ld %s", mantisChangedClass, (long)mantisChangedTag, mantisChangedHow];
    done(@{@"draws": @(mantisChanges), @"idleMs": @((now - last) * 1000), @"busy": busy});
  } else if ([method isEqualToString:@"Input.hideKeyboard"]) {
    // what a user does when the keyboard covers the next target (Detox's replaceText never opens it)
    done(@{@"ok": @([UIApplication.sharedApplication sendAction:@selector(resignFirstResponder) to:nil from:nil forEvent:nil])});
  } else {
    [NSException raise:@"MantisAgent" format:@"unknown method %@", method];
  }
}

@end

// In-process touch synthesis, KIF/EarlGrey style: UITouch + IOHIDEvent built by hand, pushed through
// -[UIApplication sendEvent:] so UIKit gesture recognizers (RN touch handler, RNGH) see a normal touch.
typedef struct __IOHIDEvent *IOHIDEventRef;
static IOHIDEventRef (*CreateHand)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, double, double, double, double, double, Boolean, Boolean, uint32_t);
static IOHIDEventRef (*CreateFinger)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t, double, double, double, double, double, double, double, double, double, double, Boolean, Boolean, uint32_t);
static void (*AppendEvent)(IOHIDEventRef, IOHIDEventRef, uint32_t);
static void (*SetInt)(IOHIDEventRef, uint32_t, long, uint32_t);

@interface UITouch (MantisPrivate)
- (void)setWindow:(UIWindow *)w;
- (void)setView:(UIView *)v;
- (void)setPhase:(UITouchPhase)p;
- (void)setTapCount:(NSUInteger)n;
- (void)setTimestamp:(NSTimeInterval)t;
- (void)_setLocationInWindow:(CGPoint)p resetPrevious:(BOOL)r;
- (void)_setIsFirstTouchForView:(BOOL)b;
- (void)_setHidEvent:(IOHIDEventRef)e;
- (void)_setPathIndex:(NSInteger)i;
- (void)_setPathIdentity:(NSInteger)i;
@end
@interface UIApplication (MantisPrivate)
- (UIEvent *)_touchesEvent;
@end
@interface UIEvent (MantisPrivate)
- (void)_clearTouches;
- (void)_addTouch:(UITouch *)t forDelayedDelivery:(BOOL)d;
- (void)_setHIDEvent:(IOHIDEventRef)e;
@end

enum { kDigitizerHand = 3, kEvRange = 1, kEvTouch = 2, kEvPosition = 4, kFieldDisplayIntegrated = (11 << 16) | 25 };

static IOHIDEventRef mantisHIDEvent(CGPoint p, UITouchPhase phase) {
  if (!CreateHand) {
    CreateHand = dlsym(RTLD_DEFAULT, "IOHIDEventCreateDigitizerEvent");
    CreateFinger = dlsym(RTLD_DEFAULT, "IOHIDEventCreateDigitizerFingerEventWithQuality");
    AppendEvent = dlsym(RTLD_DEFAULT, "IOHIDEventAppendEvent");
    SetInt = dlsym(RTLD_DEFAULT, "IOHIDEventSetIntegerValueWithOptions");
  }
  if (!CreateHand || !CreateFinger || !AppendEvent || !SetInt)
    [NSException raise:@"MantisAgent" format:@"touch synthesis unavailable: IOHIDEvent symbols missing on this iOS version"];
  uint64_t now = mach_absolute_time();
  Boolean touching = phase != UITouchPhaseEnded && phase != UITouchPhaseCancelled;
  IOHIDEventRef hand = CreateHand(kCFAllocatorDefault, now, kDigitizerHand, 0, 0, kEvTouch, 0, 0, 0, 0, 0, 0, 0, true, 0);
  SetInt(hand, kFieldDisplayIntegrated, 1, 0xF0000000);
  IOHIDEventRef finger = CreateFinger(kCFAllocatorDefault, now, 1, 2, phase == UITouchPhaseMoved ? kEvPosition : (kEvRange | kEvTouch),
                                      p.x, p.y, 0, 0, 0, 5, 5, 1, 1, 1, touching, touching, 0);
  SetInt(finger, kFieldDisplayIntegrated, 1, 0xF0000000);
  AppendEvent(hand, finger, 0);
  CFRelease(finger);
  return hand;
}

@implementation MantisAgent (Synth)
// p in screen points; the touch belongs to the topmost window that takes it at began (Modal, alert, ...).
// One finger: Began starts a gesture, Ended / Cancelled finishes it; anything out of order is an error, not a touch
// sent to a stale view or window. On an exception _touch stays set, so fingerDown's done cancels it (UIKit may have
// the touch already).
- (void)synth:(UITouchPhase)phase at:(CGPoint)sp {
  BOOL began = phase == UITouchPhaseBegan;
  if (began && _touch) [NSException raise:@"MantisAgent" format:@"another gesture is in progress"];
  if (!began && !_touch) [NSException raise:@"MantisAgent" format:@"no gesture in progress"];
  if (began) {
    UIView *hit = [self hitView:sp];
    if (!hit) [NSException raise:@"MantisAgent" format:@"no window takes a touch at (%.1f, %.1f)", sp.x, sp.y];
    UIWindow *w = hit.window;
    CGPoint p = CGPointMake(sp.x - w.frame.origin.x, sp.y - w.frame.origin.y);
    _touch = [UITouch new];
    [_touch setTapCount:1];
    [_touch setWindow:w];
    [_touch _setLocationInWindow:p resetPrevious:YES];
    [_touch setView:hit];
    [_touch _setIsFirstTouchForView:YES];
    [_touch _setPathIndex:1];
    [_touch _setPathIdentity:2];
  } else {
    [_touch _setLocationInWindow:CGPointMake(sp.x - _touch.window.frame.origin.x, sp.y - _touch.window.frame.origin.y) resetPrevious:NO];
  }
  CGPoint p = [_touch locationInView:nil];
  [_touch setPhase:phase];
  [_touch setTimestamp:NSProcessInfo.processInfo.systemUptime];
  IOHIDEventRef hid = mantisHIDEvent(p, phase);
  [_touch _setHidEvent:hid];
  UIEvent *e = [UIApplication.sharedApplication _touchesEvent];
  [e _clearTouches];
  [e _setHIDEvent:hid];
  [e _addTouch:_touch forDelayedDelivery:NO];
  CFRelease(hid);
  [UIApplication.sharedApplication sendEvent:e];
  if (phase == UITouchPhaseEnded || phase == UITouchPhaseCancelled) _touch = nil; // don't keep the view / window alive
}
@end
#endif
