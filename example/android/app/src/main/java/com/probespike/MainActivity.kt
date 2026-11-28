package com.probespike

import android.content.Intent
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "ProbeSpike"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  // e2e/stuck.mantis.js: probespike://hang?ms=N blocks the main thread for N ms, probespike://crash throws on it. Posted:
  // once the activity is resumed again (opening the URL paused it), as in an app in the foreground
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    val url = intent.data?.takeIf { it.scheme == "probespike" } ?: return
    window.decorView.post {
      when (url.host) {
        "hang" -> Thread.sleep(url.getQueryParameter("ms")?.toLongOrNull() ?: 0)
        "crash" -> throw RuntimeException("probespike://crash")
      }
    }
  }
}
