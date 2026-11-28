package com.probespike

import android.graphics.Color
import android.view.SurfaceHolder
import android.view.SurfaceView
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext

// System windows lab (App.tsx "Okna"): a SurfaceView filled magenta. Its content is on a surface of its own, outside
// the app's window, so the app's own screenshot (PixelCopy of the window) doesn't have it.
class LabPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = emptyList()
  override fun createViewManagers(context: ReactApplicationContext) = listOf(LabSurfaceManager())
}

class LabSurfaceManager : SimpleViewManager<SurfaceView>() {
  override fun getName() = "LabSurface"
  override fun createViewInstance(context: ThemedReactContext) = SurfaceView(context).apply {
    holder.addCallback(object : SurfaceHolder.Callback {
      override fun surfaceCreated(h: SurfaceHolder) = fill(h)
      override fun surfaceChanged(h: SurfaceHolder, format: Int, width: Int, height: Int) = fill(h)
      override fun surfaceDestroyed(h: SurfaceHolder) {}
    })
  }

  private fun fill(h: SurfaceHolder) {
    val c = h.lockCanvas() ?: return
    c.drawColor(Color.MAGENTA)
    h.unlockCanvasAndPost(c)
  }
}
