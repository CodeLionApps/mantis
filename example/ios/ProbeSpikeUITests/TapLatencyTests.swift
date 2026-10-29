import XCTest

// Spike Q4: cost of XCUICoordinate.tap (hybrid mode: agent computes the point, XCTest only taps)
// vs element lookup (accessibility snapshot) + tap.
final class TapLatencyTests: XCTestCase {
  func testCoordinateTapLatency() throws {
    let app = XCUIApplication()
    app.launch()

    var t = CACurrentMediaTime()
    let counter = app.buttons["Licznik 0"]
    XCTAssertTrue(counter.waitForExistence(timeout: 20))
    let frame = counter.frame
    let firstLookupMs = (CACurrentMediaTime() - t) * 1000

    let point = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: frame.midX, dy: frame.midY))
    var coordinateTaps: [Double] = []
    for _ in 0..<50 {
      t = CACurrentMediaTime()
      point.tap()
      coordinateTaps.append((CACurrentMediaTime() - t) * 1000)
    }

    var elementTaps: [Double] = []
    let any = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Licznik'")).firstMatch
    for _ in 0..<10 {
      t = CACurrentMediaTime()
      any.tap()
      elementTaps.append((CACurrentMediaTime() - t) * 1000)
    }

    t = CACurrentMediaTime()
    let delivered = app.buttons["Licznik 60"].waitForExistence(timeout: 5)
    let verifyMs = (CACurrentMediaTime() - t) * 1000

    func stats(_ xs: [Double]) -> String {
      let s = xs.sorted()
      return String(format: "{\"median\":%.1f,\"p95\":%.1f,\"max\":%.1f}", s[s.count / 2], s[Int(Double(s.count) * 0.95)], s.last!)
    }
    print("PROBE_Q4 {\"firstLookupMs\":\(Int(firstLookupMs)),\"coordinateTap\":\(stats(coordinateTaps)),\"elementTap\":\(stats(elementTaps)),\"all60Delivered\":\(delivered),\"verifyLookupMs\":\(Int(verifyMs))}")
    XCTAssertTrue(delivered)
  }
}
