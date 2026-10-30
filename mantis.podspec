require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "mantis"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]
  s.platforms    = { :ios => "15.1" }
  s.source       = { :git => "#{package["homepage"]}.git", :tag => s.version.to_s }
  s.source_files = "ios/**/*.{h,m}"
  s.frameworks   = "UIKit", "QuartzCore"
  # the agent turns exceptions into RPC errors; without this ARC leaks the objects of every frame an exception unwinds
  s.compiler_flags = "-fobjc-arc-exceptions"
  # Build-time gate: Xcode expands $(MANTIS_E2E) from the build environment, so only `MANTIS_E2E=1 xcodebuild ...`
  # defines MANTIS_E2E_1 and compiles the agent (private UIKit/IOKit API, never for the App Store). Any other build,
  # whatever the environment at `pod install`, compiles MantisAgent.m to nothing.
  s.pod_target_xcconfig = { "GCC_PREPROCESSOR_DEFINITIONS" => "$(inherited) MANTIS_E2E_$(MANTIS_E2E)=1" }
end
