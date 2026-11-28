// System windows lab (App.tsx "Okna"): a Metal view filled magenta (LabSurface) and a system permission prompt over the
// app (Lab.askPermission: contacts; a TCC prompt goes away with the app that asked, a location one stays on screen).
@import Contacts;
@import Metal;
@import QuartzCore;
#import <React/RCTBridgeModule.h>
#import <React/RCTViewManager.h>

@interface LabMetalView : UIView
@end

@implementation LabMetalView
+ (Class)layerClass { return CAMetalLayer.class; }

- (void)layoutSubviews {
  [super layoutSubviews];
  CAMetalLayer *l = (CAMetalLayer *)self.layer;
  if (!l.device) l.device = MTLCreateSystemDefaultDevice();
  CGFloat s = UIScreen.mainScreen.scale;
  l.drawableSize = CGSizeMake(self.bounds.size.width * s, self.bounds.size.height * s);
  if (!l.device || l.drawableSize.width < 1 || l.drawableSize.height < 1) return;
  id<CAMetalDrawable> d = [l nextDrawable];
  if (!d) return;
  MTLRenderPassDescriptor *rp = [MTLRenderPassDescriptor renderPassDescriptor];
  rp.colorAttachments[0].texture = d.texture;
  rp.colorAttachments[0].loadAction = MTLLoadActionClear;
  rp.colorAttachments[0].storeAction = MTLStoreActionStore;
  rp.colorAttachments[0].clearColor = MTLClearColorMake(1, 0, 1, 1);
  id<MTLCommandBuffer> b = [[l.device newCommandQueue] commandBuffer];
  [[b renderCommandEncoderWithDescriptor:rp] endEncoding];
  [b presentDrawable:d];
  [b commit];
}
@end

@interface LabSurfaceManager : RCTViewManager
@end

@implementation LabSurfaceManager
RCT_EXPORT_MODULE(LabSurface)
- (UIView *)view { return [LabMetalView new]; }
@end

@interface Lab : NSObject <RCTBridgeModule>
@end

@implementation Lab
RCT_EXPORT_MODULE()

RCT_EXPORT_METHOD(askPermission) {
  [[CNContactStore new] requestAccessForEntityType:CNEntityTypeContacts completionHandler:^(BOOL granted, NSError *e) {}];
}
@end
