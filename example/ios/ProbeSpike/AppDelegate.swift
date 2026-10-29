import UIKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  // Detox 20.x looks up the factory on the AppDelegate for reloadReactNative(); RN 0.88 keeps it in SceneDelegate.
  @objc var reactNativeFactory: NSObject?
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    true
  }
}
