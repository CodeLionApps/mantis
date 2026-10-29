# Spike fazy 0b (tap na iOS) — wyniki

*Data: 2026-10-27. RN 0.88.1 (New Arch, Hermes, bridgeless), react-native-gesture-handler 3.4.0, build **Release**.
Symulator iPhone 17 Pro, iOS 26.1, Xcode 26.1.1, macOS 26.1. Maszyna **pod obciążeniem** (load avg 9–12: buildy i emulatory Androida innych agentów).*

Kod: `ProbeSpike/ios/ProbeSpike/ProbeAgent.m` (obserwator dotyku + synteza w procesie), `ProbeSpike/probe/ios-tap/` (`bench.mjs`, `measure.sh`, surowe wyniki `wyniki-run{1,2}.json`). Odniesienia do sekcji z `rn-e2e-agent-analiza.md`.

## TL;DR

Latencja = od wysłania inputu przez runner do momentu, w którym aplikacja go widzi. Mediana / p95 / max w ms, 100 tapów na ścieżkę (pan: 20), przebieg 2 (przebieg 1 jest w tej samej skali, niżej).

| Ścieżka | tap → `sendEvent` (natywnie) | tap → commit JS | call → ack | dostarczone (Pressable / RNGH tap) | RNGH tap | RNGH pan | urządzenie fizyczne | ryzyko |
|---|---|---|---|---|---|---|---|---|
| **(b) synteza `UITouch` w procesie** | **0.7 / 1.9 / 22.9** | **5.3 / 10.8 / 25.8** | 3.1 / 9.0 / 25.4 | **100/100, 100/100** | ✅ (js 5.8 / 7.2) | ✅ 20/20 | tak w teorii (ten sam UIKit; KIF/EarlGrey tak działają), **niezweryfikowane** | prywatne API UIKit/IOKit; App Store; kruche między wersjami iOS |
| **(a) HID z hosta, `idb_companion` (gRPC, proces stały)** | 6.2 / 15.2 / 16.8 | 17.6 / 22.5 / 31.4 | 6.1 / 13.0 / 19.4 | **100/100, 100/100** | ✅ (js 18.3 / 24.1) | ✅ 20/20 | **nie** (tylko symulator) | prywatne CoreSimulator/SimulatorKit, ale po stronie hosta; zależność od idb |
| (a') HID z hosta, AXe CLI (proces na tap) | 406 / 579 | 546 / 718 | 578 / 748 | 10/10, 10/10 | ✅ | ✅ 3/3 | nie | j.w. + spawn procesu |
| (c) hybryda XCTest (z fazy 0, Q4) | — | — | 254 / 259 (syntezator), 334 / 352 (`XCUICoordinate`) | 50/50 | nie mierzone | nie mierzone | tak | publiczne API (wariant 334 ms) |

**Powtórka na cichszej maszynie** (emulator Androida wyłączony, load avg ~4; `probe/ios-tap/wyniki-quiet.json`). Mediany bez zmian, ogony krótsze:

| Ścieżka | Pressable: tap → `sendEvent` | Pressable: tap → commit JS | RNGH tap → commit JS | pełny krok Probe | RNGH pan | dostarczone |
|---|---|---|---|---|---|---|
| (b) w procesie | 0.8 / 1.6 / 5.2 | **5.8 / 8.7 / 11.5** | 6.5 / 8.0 / 11.1 | 26.1 / 29.3 / 29.7 | 20/20 | 100/100, 100/100 |
| (a) idb | 6.3 / 14.2 / 18.8 | 17.4 / 23.2 / 35.8 | 17.6 / 23.3 / 28.9 | 30.9 / 35.1 / 36.5 | 20/20 | 100/100, 100/100 |
| (a') AXe CLI | 223 / 257 | 370 / 393 | 372 / 390 | 412 / 427 | 3/3 | 10/10 |

Pełny krok Probe `Locator.tap()` (`Tree.query` → `Action.check` ze stabilnością w 2 klatkach → tap), 30 kroków na „Licznik N”:

| Ścieżka | total | check (natywnie) | input | dostarczone |
|---|---|---|---|---|
| (b) w procesie | **23.9** / 31.0 / 32.6 | 19.8 / 22.4 | 2.7 / 4.2 | 30/30 |
| (a) idb | 30.2 / 38.4 / 39.9 | 19.6 / 26.6 | 6.3 / 18.7 | 30/30 |
| (a') AXe CLI | 447 / 523 | 19.4 / 20.9 | 426 / 502 | 10/10 |
| Android z fazy 0 (dla porównania) | 95 / 166 | 38 / 82 | 34 / 68 | |

**Decyzja:**
- **Domyślnie (symulator i urządzenie): (b) synteza dotyku w procesie**, kompilowana tylko w wariancie E2E (`PROBE_E2E`) i pilnowana strażnikiem CI. To jedyna ścieżka, która spełnia kryterium wszędzie: < 1 ms do UIKit, ~5 ms do commitu JS, 100% dostarczonych, działa z RNGH (tap i pan).
- **Fallback na symulatorze: (a) HID z hosta przez stały proces** (`idb_companion` albo własny helper na SimulatorKit). Też spełnia kryterium (~6 ms / ~18 ms). Jest potrzebny do UI spoza procesu aplikacji (alerty systemowe, uprawnienia, klawiatura systemowa) oraz jako plan B, gdyby nowy iOS zepsuł (b).
- **Fallback na urządzeniu: (c) hybryda XCTest** (~254 ms). Tylko do UI systemowego i awaryjnie, gdy (b) nie działa na danej wersji iOS.
- Kryterium fazy 0b (tap < 50 ms, 100/100, natywne gesty) **spełnione na symulatorze** przez (b) i (a). **Urządzenie fizyczne: niezweryfikowane** (brak urządzenia), to pierwsza rzecz do sprawdzenia w fazie 1.

---

## 1. Metoda

- Ekrany: „Logowanie” (`Pressable` „Licznik N”) i „Gesty” (RNGH v3: `useTapGesture` → „GH tap: N”, `usePanGesture` → „GH pan: translationX” po puszczeniu). Każdy przebieg startuje od świeżego uruchomienia (`simctl terminate/launch`), nawigacja przez menu idzie tą samą ścieżką tapu.
- **Punkt obserwacji natywnej:** swizzle `-[UIApplication sendEvent:]` w `ProbeAgent.m`. Każdy began/ended (z HID, z XCTest albo z syntezy) agent wysyła jako `Touch.observed { phase, t }`. `t` to `CLOCK_MONOTONIC_RAW` sprzed wywołania oryginału.
- **Zegar:** aplikacja na symulatorze to proces hosta, więc `CLOCK_MONOTONIC_RAW` (`mach_continuous_time`) w aplikacji i `process.hrtime` w node to ten sam zegar. Sprawdzane w każdym przebiegu przez `Clock.now` (wartość agenta musi leżeć między dwoma odczytami runnera): max |skew| 0.3–1.3 ms, czyli RTT/2. Pułapka: `CLOCK_UPTIME_RAW` (z fazy 0) **nie** liczy czasu uśpienia Maca, tutaj rozjazd wynosił 3.2 doby.
- **Metryki** (t0 = runner wysyła input):
  - `native`: pierwsze `Touch.observed began` po t0.
  - `js`: runner odbiera `Tree.committed` dla commitu, w którym licznik ma nową wartość. Górne ograniczenie: + najwyżej 1 RTT zapytania, bo `Tree.query` zwraca `commitId`, a czas jest czasem dotarcia tego commitu.
  - `ack`: powrót wywołania inputu (inproc: RPC `Input.tap` po wysłaniu ended; idb: odpowiedź strumienia gRPC `hid`; AXe: wyjście procesu).
  - `dostarczone`: licznik musi wynosić dokładnie start + i po każdym tapie. Bez retry. Między tapami 30 ms przerwy (inaczej UIKit/RNGH łączy tapy w double-tap).
- **Pan:** przeciągnięcie ±100 pt w 200 ms (10 kroków), naprzemiennie w prawo i w lewo. Zaliczone, gdy znak `translationX` się zgadza.

## 2. Ścieżki: ustalenia

### (b) Synteza w procesie: **działa na iOS 26.1 bez zmian względem KIF**

- Przepis w stylu KIF: `UITouch` z prywatnymi setterami (`_setLocationInWindow:resetPrevious:`, `setPhase:`, `setView:` z `hitTest:`, `_setIsFirstTouchForView:`, `_setPathIndex/_setPathIdentity`), do tego `IOHIDEvent` (hand + finger, przez `dlsym` z IOKit) ustawiony na dotyku i na `-[UIApplication _touchesEvent]` (`_clearTouches`, `_addTouch:forDelayedDelivery:`, `_setHIDEvent:`), potem `sendEvent:`. Wszystkie selektory nadal istnieją w `UIKitCore` z iOS 26.1 (sprawdzone przez `strings`).
- `IOHIDEvent` na dotyku i evencie: według KIF od iOS 9 bez niego gesture recognizery nie widzą dotyku (wariantu bez niego nie sprawdzałem). Z nim RNGH tap i pan działają za pierwszym podejściem. `translationX` = 90 dla 100 pt, ale identycznie przy HID, więc to semantyka RNGH (próg aktywacji), a nie artefakt syntezy.
- Began i ended w tej samej iteracji runloopa wystarczają `Pressable` i RNGH tap. Pan wymaga realnych odstępów czasowych (`dispatch_after` co 20 ms).
- Kod: `ProbeAgent.m`, `Input.tap` / `Input.swipe` za `#if PROBE_E2E` (w spike'u `PROBE_E2E=1` domyślnie, bo cały build jest wariantem E2E; komentarz `ponytail:` opisuje ryzyko App Store i strażnik CI).
- Ograniczenia (z konstrukcji, nie testowane): tylko okna **własnego procesu**, tak jak na Androidzie (`dispatchTouchEvent`). Alerty systemowe, prompty uprawnień i klawiatura systemowa (na iOS 26 renderowana poza procesem) są poza zasięgiem. Tekst i tak idzie przez `insertText` (doc 3.5). Synteza bierze key window, a RN `Modal` jest prezentowany w tym samym oknie (nie testowane). Brak multi-touch (pinch), ale da się go dopisać (więcej palców w `IOHIDEvent`).

### (a) HID z hosta: **szybki tylko jako stały proces**

- `idb_companion` (FBSimulatorControl, `SimDeviceLegacyHIDClient` z SimulatorKit, komunikaty Indigo) jako serwer gRPC na hoście, a runner jako klient `@grpc/grpc-js` z `idb.proto`. Jeden strumień `hid` (down + up) na tap. ~6 ms do UIKit, ~18 ms do commitu JS. JS ≈ native + 12 ms: up dochodzi do aplikacji prawdopodobnie ~1 klatkę po down (pipeline HID symulatora), a `onPress` odpala się na up.
- To jest dokładnie to, co robi idb/AXe/argent. Dotyk przechodzi przez prawdziwy pipeline systemu, więc działa też na UI spoza aplikacji. Na urządzeniu fizycznym nie ma odpowiednika (idb nie wspiera HID na urządzeniach).
- **AXe CLI** (proces na każdy tap) to ~230–400 ms do UIKit i ~400–580 ms ack. Ładowanie frameworków i sesja HID przy każdym spawnie, a do tego AXe przy każdym kroku robi sondę AX (orientacja, ~1.3 s w trybie `batch`). `axe batch --stdin` czyta stdin do EOF, więc nie da się go użyć jako stałego procesu. **CLI-per-tap się nie nadaje.**
- Co Probe by wysłało: na start zależność opcjonalną od `idb_companion` (brew) tylko dla UI systemowego na symulatorze. Własny mały helper na SimulatorKit (ten sam mechanizm, bez gRPC i Pythona) dopiero wtedy, gdy zależność od idb zacznie przeszkadzać.

### (c) Hybryda XCTest: **bez zmian, 254–334 ms** (nie powtarzane)

Liczby z fazy 0 (Q4). Pozostaje jedyną publiczną ścieżką na urządzeniu i jedyną, która na urządzeniu sięga UI systemowego.

## 3. Konsekwencje dla fazy 1

1. **Odwrócić domyślny tryb z doc 3.5 / 8.1:** iOS domyślnie tapuje syntezą w procesie (jak Android `dispatchTouchEvent`), a hybryda XCTest staje się fallbackiem. Okno wyścigu `waitActionable` → tap z doc 5.4 spada z ~250 ms do ~3 ms (to samo RPC co check). Analizę trzeba zaktualizować (tu jej nie ruszałem).
2. **Wariant E2E jest teraz wymogiem twardym:** `PROBE_E2E` tylko w konfiguracji E2E, a strażnik CI sprawdza binarkę Release/App Store na brak symboli i selektorów (`_setHidEvent:`, `_touchesEvent`, `IOHIDEventCreateDigitizer*`, `ProbeAgent`). Swizzle `sendEvent:` (obserwator) też tylko w E2E.
3. **Pierwsze zadanie fazy 1 na iOS: uruchomić `Input.tap/swipe` na fizycznym iPhonie** (ta sama binarka, podpisana dev certem). Jeśli nie zadziała, na urządzeniu domyślny staje się (c) i kryterium < 50 ms na urządzeniu nie jest osiągalne.
4. **Macierz wersji iOS w CI pluginu** (co najmniej najnowsza i poprzednia major): synteza to kod KIF-owy, więc pęknie po cichu. Smoke test = ten benchmark (dostarczone == tapy).
5. **„Driver systemowy” (faza 2) na symulatorze = HID z hosta przez stały proces**, na urządzeniu = XCTest. Ta sama abstrakcja `systemDriver.tap(x, y)`, używana tylko poza procesem aplikacji.
6. Pełny krok `tap` na iOS: **~24 ms mediana / ~31 ms p95** (vs Android 95 / 166). Na iOS dominuje 1 klatka stabilności (`check` ~20 ms). Na Androidzie warto sprawdzić, czemu `check` i `input` są 2–5× droższe (emulator? `Choreographer`?).
7. Zegar: do korelacji runner↔agent na symulatorze używać `CLOCK_MONOTONIC_RAW` (= `process.hrtime`), nie `CLOCK_UPTIME_RAW`.

## 4. Nie sprawdzone

- Urządzenie fizyczne (wszystkie ścieżki).
- Pomiar na nieobciążonej maszynie: oba przebiegi przy load avg 9–12. Mediany są stabilne między przebiegami, ogony (p95/max) prawdopodobnie zawyżone. `measure.sh` jest do powtórki.
- (b): ScrollView/FlatList (momentum), `Modal`, `TextInput` focus przez syntetyczny tap, multi-touch, współistnienie z prawdziwym dotykiem użytkownika.
- (a): własny helper na SimulatorKit (mierzone tylko idb jako proxy tego samego mechanizmu).

## 5. Reprodukcja

```bash
cd ProbeSpike
brew install facebook/fb/idb-companion cameroncooke/axe/axe   # (a), (a')
cd ios && bundle exec pod install
xcodebuild build -workspace ProbeSpike.xcworkspace -scheme ProbeSpike -configuration Release \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath build/dd CODE_SIGNING_ALLOWED=NO
cd .. && probe/ios-tap/measure.sh > wyniki.json     # ~1 min, limit 10 min; wolny port 9123, brak innej apki na 9123
# pojedyncza ścieżka: node probe/ios-tap/bench.mjs <inproc|idb|axe-cli> [taps=100] [pans=20]
# zmienne: UDID (domyślnie 068243DC-…), TAPS, PANS
```
