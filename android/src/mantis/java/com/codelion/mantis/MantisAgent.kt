package com.codelion.mantis

import android.app.Activity
import android.app.Application
import android.content.Context
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.TypedValue
import android.view.Choreographer
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.view.inspector.WindowInspector
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.ScrollView
import androidx.activity.findViewTreeOnBackPressedDispatcherOwner
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.facebook.react.modules.websocket.WebSocketModule
import com.facebook.react.uimanager.RootView
import com.facebook.react.uimanager.TouchTargetHelper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.net.InetAddress
import java.net.Socket
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory

/**
 * Mantis native agent. Compiled in only with MANTIS_E2E=1 (src/mantis, see build.gradle) and started by
 * MantisInitProvider. The app must allow cleartext traffic to localhost (network security config) in that build.
 *
 * Passive until a runner listens on the host: dials ws://localhost:9123 (adb reverse) and retries every 2 s.
 * Own socket, independent of the JS thread, so measuring / hit-testing / input work while JS is busy.
 * All view work on the main thread. Coordinates exchanged with the runner are dp (= JS units).
 */
object MantisAgent {
  private const val URL = "ws://localhost:9123/?role=native"
  private val main = Handler(Looper.getMainLooper())
  private val client = OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).socketFactory(NoDelay).build()

  /**
   * TCP_NODELAY. Without it a message over 8 KB (OkHttp writes 8 KB segments) waits ~45 ms for the ACK of the first
   * segment (Nagle vs adbd's delayed ACK; S22, adb reverse): every snapshot of a busy screen.
   */
  private object NoDelay : SocketFactory() {
    private val d = SocketFactory.getDefault()
    private fun Socket.nd() = apply { tcpNoDelay = true }
    override fun createSocket() = d.createSocket().nd()
    override fun createSocket(host: String, port: Int) = d.createSocket(host, port).nd()
    override fun createSocket(host: String, port: Int, local: InetAddress, localPort: Int) = d.createSocket(host, port, local, localPort).nd()
    override fun createSocket(host: InetAddress, port: Int) = d.createSocket(host, port).nd()
    override fun createSocket(host: InetAddress, port: Int, local: InetAddress, localPort: Int) = d.createSocket(host, port, local, localPort).nd()
  }
  private lateinit var app: Application
  private var activity: Activity? = null
  private var ws: WebSocket? = null

  @JvmStatic
  fun install(application: Application) {
    app = application
    // the JS agent's socket is RN's WebSocket: same fix. ponytail: replaces an app's own custom builder (E2E builds
    // only; RN has no getter to chain it)
    WebSocketModule.setCustomClientBuilder { it.socketFactory(NoDelay) }
    app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
      override fun onActivityResumed(a: Activity) { activity = a }
      override fun onActivityPaused(a: Activity) { if (activity == a) activity = null }
      override fun onActivityCreated(a: Activity, b: Bundle?) {}
      override fun onActivityStarted(a: Activity) {}
      override fun onActivityStopped(a: Activity) {}
      override fun onActivitySaveInstanceState(a: Activity, b: Bundle) {}
      override fun onActivityDestroyed(a: Activity) {}
    })
    connect()
  }

  private fun connect() {
    ws = client.newWebSocket(Request.Builder().url(URL).build(), object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        // v: src/runner PROTOCOL
        webSocket.send(JSONObject().put("method", "Agent.hello")
          .put("params", JSONObject().put("role", "native").put("platform", "android").put("v", 1)).toString())
      }
      // OkHttp's reader thread: an exception here would restart the socket and fail every RPC in flight, so validate
      // the frame first; a frame without a numeric id has nothing to answer
      override fun onMessage(webSocket: WebSocket, text: String) {
        val msg = try { JSONObject(text) } catch (e: Exception) { return }
        val id = (msg.opt("id") as? Number)?.toInt() ?: return
        val method = msg.optString("method")
        val params = msg.optJSONObject("params") ?: JSONObject()
        // exactly one reply per request, whatever path (sync, frame callback, exception) gets there first
        var replied = false
        val done: (Any?) -> Unit = { result ->
          if (!replied) {
            replied = true
            if (result is Throwable) reply(id, null, result.toString()) else reply(id, result, null)
          }
        }
        main.post { guard(done) { handle(method, params, done) } }
      }
      // the runner closes gracefully (e.g. a refused hello); OkHttp calls onClosed only once both sides sent close
      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = retry()
      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = retry()
    })
  }

  // 2 s like the iOS and JS agents (README); the runner is either up already or a test file away
  private fun retry() { main.postDelayed({ connect() }, 2000) }

  private fun reply(id: Int, result: Any?, error: String?) {
    val out = JSONObject().put("id", id)
    if (error != null) out.put("error", JSONObject().put("message", error)) else out.put("result", result ?: JSONObject.NULL)
    ws?.send(out.toString())
  }

  /**
   * Every callback that answers an RPC runs through this (also the frame callbacks, which run long after handle
   * returned): an exception becomes the RPC's error instead of crashing the app and with it the whole E2E session.
   */
  private inline fun guard(noinline done: (Any?) -> Unit, body: () -> Unit) {
    try { body() } catch (e: Throwable) { done(e) }
  }

  private fun onFrame(done: (Any?) -> Unit, body: () -> Unit) =
    Choreographer.getInstance().postFrameCallback { guard(done, body) }

  /** The finger that is down (tap, scroll); x, y = its last position, screen px. */
  private class Finger(val win: View, val down: Long, var x: Float, var y: Float)
  private var finger: Finger? = null

  /**
   * Puts a finger down. One gesture at a time. The returned done ends the RPC: on an error, or when the gesture is
   * still down after 10 s (frame callbacks stalled), it sends ACTION_CANCEL first, so RN's JSTouchDispatcher never
   * keeps a half gesture that mixes into the next one. 10 s: a scroll is ~10 frames, seconds on a starved emulator
   * (measured: up to 5.4 s), and it must fire before the runner's 15 s RPC timeout.
   */
  private fun fingerDown(win: View, x: Float, y: Float, done: (Any?) -> Unit): Pair<Finger, (Any?) -> Unit> {
    check(finger == null) { "another gesture is in progress (actions on one app run one at a time)" }
    val f = Finger(win, SystemClock.uptimeMillis(), x, y)
    finger = f
    lateinit var watchdog: Runnable
    val end: (Any?) -> Unit = { r ->
      main.removeCallbacks(watchdog)
      if (finger === f) {
        runCatching { touch(win, f.down, SystemClock.uptimeMillis(), MotionEvent.ACTION_CANCEL, f.x, f.y) }
        finger = null
      }
      done(r)
    }
    watchdog = Runnable { end(IllegalStateException("gesture still down after 10 s, cancelled")) }
    main.postDelayed(watchdog, 10000)
    try { touch(win, f.down, f.down, MotionEvent.ACTION_DOWN, x, y) } catch (e: Throwable) { end(e); throw e }
    return f to end
  }

  /** MOVE / UP for [f]; fails if it was cancelled meanwhile (watchdog). UP lifts it: the next gesture may start. */
  private fun move(f: Finger, action: Int, x: Float, y: Float) {
    check(finger === f) { "gesture cancelled" }
    f.x = x
    f.y = y
    touch(f.win, f.down, SystemClock.uptimeMillis(), action, x, y)
    if (action == MotionEvent.ACTION_UP) finger = null
  }

  // null while no activity is resumed, e.g. a system dialog (permission prompt) is in front of the app
  private val decorOrNull: View? get() = activity?.window?.decorView
  private val decor: View get() = decorOrNull ?: error("no resumed activity")
  private val density: Float get() = app.resources.displayMetrics.density

  /** All windows of this process (activity, Modal dialogs, popups), topmost first. Coordinates are screen-based. */
  private fun roots(): List<View> {
    // ponytail: API 29+ (WindowInspector); below that only the activity window, so no Modal support
    val all = if (Build.VERSION.SDK_INT >= 29) WindowInspector.getGlobalWindowViews() else listOfNotNull(decorOrNull)
    return all.filter { it.isShown }.reversed()
  }

  private fun findView(tag: Int): View? = roots().firstNotNullOfOrNull { it.findViewById<View>(tag) }

  private fun screenRect(v: View): Rect {
    val l = IntArray(2).also { v.getLocationOnScreen(it) }
    return Rect(l[0], l[1], l[0] + v.width, l[1] + v.height)
  }

  /** Topmost window containing the point (px, screen); where a real touch would land. */
  private fun windowAt(x: Float, y: Float): View? = roots().firstOrNull { screenRect(it).contains(x.toInt(), y.toInt()) }

  private fun rectOf(v: View): JSONObject {
    val r = screenRect(v)
    return JSONObject().put("x", r.left / density).put("y", r.top / density)
      .put("width", v.width / density).put("height", v.height / density)
  }

  private fun isScroller(v: View) = v is ScrollView || v is HorizontalScrollView

  /** Part of the screen where [v] can be seen: its window clipped by every scrolling ancestor. */
  private fun viewport(v: View): Rect {
    val clip = screenRect(v.rootView)
    var cur = v.parent
    while (cur is View) { if (isScroller(cur) && !clip.intersect(screenRect(cur))) clip.setEmpty(); cur = cur.parent }
    return clip
  }

  private fun nearestScroller(v: View): View? {
    var cur = v.parent
    while (cur is View) { if (isScroller(cur)) return cur; cur = cur.parent }
    return null
  }

  /**
   * Visible share of the view the way Detox's toBeVisible measures it: min of Espresso isDisplayingAtLeast and
   * IsDisplayingAtLeastDetoxMatcher (visible rect ∩ every ancestor's, area capped at screen minus status + action
   * bar). Neither clips to the screen, so an edge-to-edge tab bar under the nav bar still counts. 0 = not shown.
   */
  private fun visibleRatio(v: View?): Double {
    if (v == null || !v.isShown || v.width == 0 || v.height == 0) return 0.0
    val r = Rect()
    if (!v.getGlobalVisibleRect(r)) return 0.0
    val dm = app.resources.displayMetrics
    val w = minOf(Math.abs(v.width * v.scaleX).toDouble(), dm.widthPixels.toDouble())
    val h = Math.abs(v.height * v.scaleY).toDouble()
    if (w == 0.0 || h == 0.0) return 0.0 // scaled to nothing; NaN would make JSONArray.put throw
    val espresso = r.width().toDouble() * r.height() / (w * minOf(h, dm.heightPixels.toDouble()))
    val pr = Rect()
    var p = v.parent as? View
    while (p != null) { p.getGlobalVisibleRect(pr); if (!r.intersect(pr)) return 0.0; p = p.parent as? View }
    val tv = TypedValue()
    val actionBar = if (v.context.theme.resolveAttribute(android.R.attr.actionBarSize, tv, true))
      TypedValue.complexToDimensionPixelSize(tv.data, dm) else 0
    val statusBarId = app.resources.getIdentifier("status_bar_height", "dimen", "android")
    val statusBar = if (statusBarId > 0) app.resources.getDimensionPixelSize(statusBarId) else 0
    val detox = r.width().toDouble() * r.height() / (w * minOf(h, (dm.heightPixels - statusBar - actionBar).toDouble()))
    return minOf(espresso, detox)
  }

  private fun sameRect(a: JSONObject, b: JSONObject) =
    listOf("x", "y", "width", "height").all { Math.abs(a.getDouble(it) - b.getDouble(it)) < 0.01 } // any px change: a list still
    // drifting at <0.5 dp/frame makes Android's ScrollView eat the next DOWN as "stop fling"

  /**
   * Fabric: View.id == React tag. Returns the React root of a window: ReactSurfaceView / ReactRootView, or a Modal's
   * DialogRootViewGroup. By interface, not class name: R8 renames the classes (RN ships no keep rule for them).
   */
  private fun reactRoot(v: View): ViewGroup? {
    if (v is ViewGroup && v is RootView) return v
    if (v is ViewGroup) for (i in 0 until v.childCount) reactRoot(v.getChildAt(i))?.let { return it }
    return null
  }

  private fun ancestorTags(v: View?): JSONArray {
    val out = JSONArray()
    var cur: Any? = v
    while (cur is View) { if (cur.id > 0) out.put(cur.id); cur = cur.parent }
    return out
  }

  /** Hit-test like RN's own touch dispatch, in the topmost window at the point; IME counts as an overlay. */
  private fun hitTest(xDp: Float, yDp: Float): JSONObject {
    val x = xDp * density
    val y = yDp * density
    val decor = decorOrNull ?: return JSONObject().put("covered", "no resumed activity")
    val ime = ViewCompat.getRootWindowInsets(decor)?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0
    if (ime > 0 && y > screenRect(decor).bottom - ime) return JSONObject().put("covered", "keyboard")
    val win = windowAt(x, y) ?: return JSONObject().put("covered", "no window")
    val root = reactRoot(win) ?: return JSONObject().put("covered", "window ${win.javaClass.simpleName}")
    val rootLoc = IntArray(2).also { root.getLocationOnScreen(it) }
    val tag = TouchTargetHelper.findTargetTagForTouch(x - rootLoc[0], y - rootLoc[1], root)
    // a nested <Text> hit returns the virtual span's tag, which has no View: chain = span + the view under the point
    val view = root.findViewById<View>(tag) ?: leafAt(root, x, y)
    return JSONObject().put("tag", tag).put("class", view.javaClass.simpleName)
      .put("chain", ancestorTags(view).apply { if (view.id != tag) put(tag) })
  }

  /**
   * [v] is not covered: a touch at the centre of its visible part lands on it, a descendant, its own ancestor (v is
   * pointerEvents none), or a view of the same window that doesn't cover all of that part (a card's content drawn
   * over the card).
   * Covered: by the keyboard, another window (Modal, dialog), or a view over all of it (sheet backdrop).
   */
  private fun reaches(v: View): Boolean {
    val r = Rect()
    if (!v.getGlobalVisibleRect(r)) return false
    val o = IntArray(2).also { v.rootView.getLocationOnScreen(it) }
    r.offset(o[0], o[1])
    val chain = hitTest(r.exactCenterX() / density, r.exactCenterY() / density).optJSONArray("chain") ?: return false
    val hit = (0 until chain.length()).map { chain.getInt(it) }
    if (v.id in hit) return true
    val up = ancestorTags(v)
    if ((0 until up.length()).any { up.getInt(it) == hit.firstOrNull() }) return true
    val over = hit.firstOrNull()?.let { findView(it) } ?: return false
    return over.rootView === v.rootView && !screenRect(over).contains(r)
  }

  private fun leafAt(v: View, x: Float, y: Float): View {
    if (v is ViewGroup) for (i in v.childCount - 1 downTo 0) {
      val c = v.getChildAt(i)
      if (c.isShown && screenRect(c).contains(x.toInt(), y.toInt())) return leafAt(c, x, y)
    }
    return v
  }

  private fun handle(method: String, p: JSONObject, done: (Any?) -> Unit) {
    when (method) {
      // Visible share per tag (Detox semantics, see visibleRatio), for toBeInViewport and filter({ visible }).
      // hit: true (App.snapshot) adds per tag whether a touch at the centre of its visible part reaches it (null = no
      // resumed activity, can't tell), and once: focused (a window of the app has focus; false under a system
      // dialog), keyboard (IME rect or null) and screen size, all in screen dp.
      "Layout.visibility" -> {
        val tags = p.getJSONArray("tags")
        val withHit = p.optBoolean("hit")
        val out = JSONArray()
        val shown = JSONArray() // in a window and not hidden: what Detox/Espresso can match (screens below are not)
        val hits = JSONArray()
        for (i in 0 until tags.length()) {
          val v = if (tags.isNull(i)) null else findView(tags.getInt(i))
          val ratio = visibleRatio(v)
          out.put(ratio)
          shown.put(v?.isShown == true)
          if (withHit) hits.put(if (ratio == 0.0) false else if (decorOrNull == null) JSONObject.NULL else reaches(v!!))
        }
        val res = JSONObject().put("ratios", out).put("shown", shown)
        if (withHit) {
          val decor = decorOrNull
          val win = decor ?: roots().lastOrNull() // the activity window is the bottom one
          val ime = decor?.let { ViewCompat.getRootWindowInsets(it)?.getInsets(WindowInsetsCompat.Type.ime())?.bottom } ?: 0
          val keyboard = if (decor != null && ime > 0) screenRect(decor).let {
            JSONObject().put("x", it.left / density).put("y", (it.bottom - ime) / density)
              .put("width", it.width() / density).put("height", ime / density)
          } else JSONObject.NULL
          res.put("hit", hits).put("focused", roots().any { it.hasWindowFocus() }).put("keyboard", keyboard)
            .put("screen", JSONObject().put("width", (win?.width ?: 0) / density).put("height", (win?.height ?: 0) / density)
              .put("density", density))
        }
        done(res)
      }

      // Detox scrollTo(edge): jump the scroll view to its start/end (programmatic, like Detox's edge scroll).
      // scrollTo to the exact end, not fullScroll(): that one smooth-scrolls and moves focus (opens the IME next to a
      // TextInput). ReactScrollView.scrollTo also updates Fabric's scroll state.
      "Input.scrollToEdge" -> {
        val sv = findView(p.getInt("tag"))
        val end = p.getString("edge") in setOf("bottom", "right")
        val content = (sv as? ViewGroup)?.getChildAt(0)
        when (sv) {
          is ScrollView -> sv.scrollTo(0, if (end && content != null) maxOf(0, content.height - (sv.height - sv.paddingTop - sv.paddingBottom)) else 0)
          is HorizontalScrollView -> sv.scrollTo(if (end && content != null) maxOf(0, content.width - (sv.width - sv.paddingLeft - sv.paddingRight)) else 0, 0)
          else -> { done(JSONObject().put("ok", false).put("reason", "not a scroll view")); return }
        }
        // 2 frames, like Input.scroll: the scroll events reach the JS queue before the runner queries again
        onFrame(done) { onFrame(done) { done(JSONObject().put("ok", true)) } }
      }

      // Actionability, native half: exists natively, stable across 2 frames, receives events at center.
      "Action.check" -> {
        val tag = p.getInt("tag")
        val tags = p.getJSONArray("tags").let { a -> (0 until a.length()).map { a.optInt(it) }.toSet() }
        val v = findView(tag)
        if (v == null || !v.isShown) { done(JSONObject().put("ok", false).put("reason", "not mounted natively")); return }
        // a just-shown window (Modal = Dialog) gets its final layout (insets) only around the time WM focuses it;
        // 2 stable frames before that can still be the provisional position (measured: shift ~36 dp, focus +~130 ms)
        if (!v.rootView.hasWindowFocus()) { done(JSONObject().put("ok", false).put("reason", "window not focused")); return }
        val r1 = rectOf(v)
        onFrame(done) {
          val r2 = rectOf(v)
          if (!sameRect(r1, r2)) { done(JSONObject().put("ok", false).put("reason", "not stable").put("r1", r1).put("r2", r2)); return@onFrame }
          val cx = (r2.getDouble("x") + r2.getDouble("width") / 2).toFloat()
          val cy = (r2.getDouble("y") + r2.getDouble("height") / 2).toFloat()
          // viewport: centre must be on screen and not clipped by a scroll view; delta tells the runner where to scroll
          val vp = viewport(v)
          if (!vp.contains((cx * density).toInt(), (cy * density).toInt())) {
            val sv = nearestScroller(v)?.let { viewport(it).apply { intersect(screenRect(it)) } }
            done(JSONObject().put("ok", false).put("reason", "not in viewport").put("rect", r2)
              .put("delta", sv?.let { cy - it.exactCenterY() / density } ?: 0f))
            return@onFrame
          }
          val hit = hitTest(cx, cy)
          val chain = hit.optJSONArray("chain")
          val receives = chain != null && (0 until chain.length()).any { chain.getInt(it) in tags }
          done(JSONObject().put("ok", receives).put("point", JSONObject().put("x", cx).put("y", cy)).put("rect", r2)
            .put("hit", hit).put("reason", if (receives) null else "covered by ${hit.opt("class") ?: hit.opt("covered")} (tag ${hit.opt("tag")}) at ($cx, $cy)"))
        }
      }

      "Input.tap" -> {
        val x = p.getDouble("x").toFloat() * density
        val y = p.getDouble("y").toFloat() * density
        val win = windowAt(x, y) ?: error("no window at (${x / density}, ${y / density})")
        val (f, end) = fingerDown(win, x, y, done)
        // hold = until next frame (~16 ms), enough for Pressable / gesture handlers to see DOWN
        onFrame(end) {
          move(f, MotionEvent.ACTION_UP, x, y)
          end(JSONObject().put("ok", true))
        }
      }

      // Scroll = a real drag on the scroll view: DOWN, eased MOVEs (one per frame), finger held still (MOVEs at the
      // end point) for > 100 ms = VelocityTracker's horizon, then UP. Velocity at UP is 0: no fling, deterministic.
      // dy (dp) = how far content should move up (positive = reveal content below).
      "Input.scroll" -> {
        val sv = findView(p.getInt("tag"))
        // JS commit can be ~1 frame ahead of the native mount: not ready yet, the runner retries next frame
        if (sv == null || !sv.isShown) { done(JSONObject().put("ok", false).put("reason", "scroll view not mounted natively")); return }
        // Rect.intersect leaves the rect as it was when there is no overlap
        val vp = viewport(sv)
        if (!vp.intersect(screenRect(sv)) || vp.isEmpty) { done(JSONObject().put("ok", false).put("reason", "scroll view not on screen")); return }
        val slop = ViewConfiguration.get(sv.context).scaledTouchSlop
        val want = p.getDouble("dy").toFloat() * density
        // dy 0 would put DOWN and UP on one point: a tap on whatever is under it
        if (want == 0f) { done(JSONObject().put("ok", false).put("reason", "dy is 0, nothing to scroll")); return }
        val startY = sv.scrollY
        val amount = (Math.abs(want) + slop).coerceAtMost(vp.height() * 0.8f) * Math.signum(want)
        val x = vp.exactCenterX()
        val y0 = vp.exactCenterY() + amount / 2
        val y1 = vp.exactCenterY() - amount / 2
        val hit = hitTest(x / density, y0 / density).optJSONArray("chain")
        if (hit == null || (0 until hit.length()).none { hit.getInt(it) == sv.id }) {
          done(JSONObject().put("ok", false).put("reason", "scroll view covered at start point")); return
        }
        val win = windowAt(x, y0) ?: error("no window at the scroll view")
        val (f, end) = fingerDown(win, x, y0, done)
        val moves = p.optInt("moves", 6).takeIf { it > 0 } ?: 6
        var frame = 0
        var lastMove = f.down
        Choreographer.getInstance().postFrameCallback(object : Choreographer.FrameCallback {
          override fun doFrame(t: Long) = guard(end) {
            frame++
            val now = SystemClock.uptimeMillis()
            if (frame <= moves) {
              val k = 1 - (1 - frame.toFloat() / moves).let { it * it } // ease-out
              move(f, MotionEvent.ACTION_MOVE, x, y0 + (y1 - y0) * k)
              lastMove = now
            } else if (now - lastMove < 110) {
              move(f, MotionEvent.ACTION_MOVE, x, y1)
            } else {
              move(f, MotionEvent.ACTION_UP, x, y1)
              // 2 frames: lets the scroll events of the UP (momentum begin) reach the JS queue before the runner
              // queries again, so the "scroll view animating" check cannot miss them
              // moved: false = the drag happened but the content didn't move (at its end), the runner stops scrolling
              onFrame(end) { onFrame(end) { end(JSONObject().put("ok", true).put("px", amount).put("moved", sv.scrollY != startY)) } }
              return@guard
            }
            Choreographer.getInstance().postFrameCallback(this)
          }
        })
      }

      // Text via the IME path (InputConnection), not by setting props. replace = select all first (Playwright fill).
      "Input.typeText" -> {
        // the window that has window focus: popups never get it, but keep a focused view of their own (Samsung's text
        // selection toolbar after select-all: a focused RelativeLayout above the activity)
        val focused = roots().firstOrNull { it.hasWindowFocus() }?.findFocus()
        if (focused !is EditText) { done(JSONObject().put("ok", false).put("reason", "focused: ${focused?.javaClass?.simpleName}")); return }
        val want = p.optJSONArray("tags")?.let { t -> (0 until t.length()).map { t.optInt(it) } }
        if (want != null && focused.id !in want) { done(JSONObject().put("ok", false).put("reason", "focus still on tag ${focused.id}")); return }
        val ic = focused.onCreateInputConnection(EditorInfo()) ?: error("no InputConnection")
        if (p.optBoolean("replace")) ic.setSelection(0, focused.text.length)
        ic.commitText(p.getString("text"), 1)
        done(JSONObject().put("ok", true).put("focusedTag", focused.id))
      }

      // fill on a text input no tap can reach: focus it the way a tap would (iOS: alpha 0; Android never reports it
      // today, but both agents answer the same methods)
      "Input.focus" -> {
        val et = findView(p.getInt("tag"))?.let { editTextIn(it) }
        val ok = et?.requestFocus() == true
        if (ok) (app.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(et, 0)
        done(JSONObject().put("ok", ok))
      }

      // What a user does when the soft keyboard covers the next target (Detox's replaceText never opens it)
      "Input.hideKeyboard" -> {
        val imm = app.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        val hidden = roots().any { imm.hideSoftInputFromWindow(it.windowToken, 0) }
        done(JSONObject().put("ok", hidden))
      }

      // The back button, in-process (~ms instead of `adb shell input keyevent 4`'s process start), to the window that
      // has focus: the activity, or a Modal's Dialog (closes like a real back: onRequestClose). First as a key event
      // (what the system sends without predictive back; a Modal's OnKeyListener takes it either way), then, when nothing
      // took it (predictive back: targetSdk 36 on Android 16 never calls onBackPressed from a key), the window's
      // OnBackPressedDispatcher, which the system's OnBackInvokedCallback would call. On the root screen that ends like a
      // real back too (RN: JS has no handler → invokeDefaultOnBackPressed → the task goes to the background).
      // ok: false = do it the system's way (adb keyevent): no window of the app has focus (system dialog), the keyboard is
      // up (a real back closes the IME, which an in-process event never reaches), or nothing in the window took it.
      // ponytail: non-predictive back with an enabled androidx callback goes key-first, i.e. through
      // Activity.onBackPressed like a real key; the dispatcher only runs if that one returns unhandled.
      "Input.back" -> {
        val win = roots().firstOrNull { it.hasWindowFocus() }
          ?: run { done(JSONObject().put("ok", false).put("reason", "no window of the app has focus")); return }
        if (ViewCompat.getRootWindowInsets(win)?.isVisible(WindowInsetsCompat.Type.ime()) == true) {
          done(JSONObject().put("ok", false).put("reason", "keyboard on screen")); return
        }
        val t = SystemClock.uptimeMillis()
        val key = { action: Int -> win.dispatchKeyEvent(KeyEvent(t, SystemClock.uptimeMillis(), action, KeyEvent.KEYCODE_BACK, 0, 0,
          KeyCharacterMap.VIRTUAL_KEYBOARD, 0, KeyEvent.FLAG_FROM_SYSTEM or KeyEvent.FLAG_VIRTUAL_HARD_KEY, InputDevice.SOURCE_KEYBOARD)) }
        key(KeyEvent.ACTION_DOWN)
        val via = if (key(KeyEvent.ACTION_UP)) "key" else win.findViewTreeOnBackPressedDispatcherOwner()?.let {
          it.onBackPressedDispatcher.onBackPressed(); "dispatcher"
        }
        done(if (via == null) JSONObject().put("ok", false).put("reason", "back not handled by ${win.javaClass.simpleName}")
          else JSONObject().put("ok", true).put("via", via).put("window", win.javaClass.simpleName))
      }

      else -> error("unknown method $method")
    }
  }

  private fun editTextIn(v: View): EditText? {
    if (v is EditText) return v
    if (v is ViewGroup) for (i in 0 until v.childCount) editTextIn(v.getChildAt(i))?.let { return it }
    return null
  }

  /** x, y in screen px; delivered to [win]'s root view in its own coordinates. */
  private fun touch(win: View, down: Long, now: Long, action: Int, x: Float, y: Float) {
    val l = IntArray(2).also { win.getLocationOnScreen(it) }
    val ev = MotionEvent.obtain(down, now, action, x - l[0], y - l[1], 0)
    ev.source = InputDevice.SOURCE_TOUCHSCREEN
    win.dispatchTouchEvent(ev)
    ev.recycle()
  }
}
