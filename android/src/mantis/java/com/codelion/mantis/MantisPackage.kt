package com.codelion.mantis

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager

/** MANTIS_E2E=1 build: the module the JS agent reads the runner's token through. The agent starts from MantisInitProvider. */
class MantisPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(MantisModule(context))
  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}

// ponytail: a legacy module (TurboModule interop, on by default in the New Architecture); a TurboModule needs a codegen
// spec for one getter
class MantisModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName() = "Mantis"

  /** MantisAgent.token: null until the first activity is created, "" when it was launched without one. */
  @ReactMethod(isBlockingSynchronousMethod = true)
  fun token(): String? = MantisAgent.token
}
