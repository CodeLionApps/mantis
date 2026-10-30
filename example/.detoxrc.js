/** Detox config for the example app. Build with MANTIS_E2E=1 (see README), the agents are compiled in only then. */
const apk = 'android/app/build/outputs/apk';
module.exports = {
  testRunner: {
    args: { $0: 'jest', config: 'e2e/jest.config.js' },
    jest: { setupTimeout: 180000 },
  },
  apps: {
    'android.release': {
      type: 'android.apk',
      binaryPath: `${apk}/release/app-release.apk`,
      testBinaryPath: `${apk}/androidTest/release/app-release-androidTest.apk`,
      // --rerun: the JS agent lives in ../src (file: link), outside what Gradle watches for the bundle task
      build:
        'cd android && MANTIS_E2E=1 ./gradlew :app:createBundleReleaseJsAndAssets --rerun assembleRelease :app:assembleAndroidTest -DtestBuildType=release',
    },
    'ios.release': {
      type: 'ios.app',
      binaryPath: 'ios/build/Build/Products/Release-iphonesimulator/ProbeSpike.app',
      build:
        'MANTIS_E2E=1 xcodebuild -workspace ios/ProbeSpike.xcworkspace -scheme ProbeSpike -configuration Release -sdk iphonesimulator -derivedDataPath ios/build -quiet',
    },
  },
  devices: {
    emulator: { type: 'android.attached', device: { adbName: process.env.ANDROID_SERIAL || 'emulator-5554' } },
    simulator: { type: 'ios.simulator', device: { type: process.env.SIM_TYPE || 'iPhone 17' } },
  },
  configurations: {
    'android.release': { device: 'emulator', app: 'android.release' },
    'ios.release': { device: 'simulator', app: 'ios.release' },
  },
};
