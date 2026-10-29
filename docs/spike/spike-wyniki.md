# Spike fazy 0 — wyniki

*Data: 2026-10-27. RN 0.88.1 (New Architecture, Hermes, bridgeless), React 19.3.0. Wszystkie pomiary na buildach **Release**.
Android: emulator API 34 arm64 (`Detox_Emulator`). iOS: symulator iPhone 17 Pro, iOS 26.1, Xcode 26.1.1.*

Kod: `ProbeSpike/` (aplikacja + agent + runner). Odniesienia do sekcji z `rn-e2e-agent-analiza.md`.

## TL;DR

| | Wynik | Werdykt |
|---|---|---|
| Kryterium fazy 0 (Android): logowanie 100/100 bez sleepów | **100/100** (dodatkowo 100/100 i 30/30 we wcześniejszych przebiegach) | ✅ |
| Kryterium fazy 0: krok < 100 ms | mediana: tap **95 ms**, fill **76 ms**; p95: 166 / 141 ms | ⚠️ mediana tak, p95 nie |
| Q1 tag natywny == tag JS (Fabric) | tak, Android i iOS | ✅ |
| Q2 reload `ReactHost` w Release | działa, ~80 ms (Android), ~30 ms (iOS) | ✅ |
| Q3 renderer w Release rejestruje się w hooku DevTools | tak (`bundleType: 0`), commity dochodzą | ✅ |
| Q4 latencja tapu przez XCTest na symulatorze | **~334 ms** (`XCUICoordinate`), **~254 ms** (bezpośredni syntezator) | ❌ dla budżetu 100 ms |
| Q5 `getBoundingClientRect` / `measureInWindow` | czytają zcommitowane drzewo; natywny widok dogania po **~1 klatce** | ✅ (z konsekwencjami) |

**Decyzja:** Android: **GO**, model Playwrighta działa w praktyce. iOS: **warunkowo GO**. Q1–Q3 OK, ale tryb hybrydowy (tap przez XCTest) nie zmieści się w 100 ms/krok. Przed MVP potrzebny jeden krótki spike ścieżki tapu na iOS (niżej).

---

## 1. Co zbudowano

- `ProbeSpike/App.tsx` to ekran logowania celowo wrogi naiwnym driverom: fake network 100–600 ms, przycisk `disabled` do wypełnienia pól, wjazd ekranu animacją z native driverem (`translateX`) i toast, który przez 300–700 ms przykrywa „Wyloguj”.
- `probe/agent/install.js` to agent JS: własny `__REACT_DEVTOOLS_GLOBAL_HOOK__`, query po fiberach (role/name, text, label, testID), strict mode, `getBoundingClientRect`, event `Tree.committed`.
- `index.e2e.js` to osobny entry (agent musi być pierwszy). Android: `jsMainModulePath`/`entryFile`, iOS: `ENTRY_FILE` w fazie bundlowania.
- `android/.../ProbeAgent.kt` to natywny agent z **własnym WebSocketem** (OkHttp), niezależnym od wątku JS. Robi pomiar, stabilność w 2 klatkach `Choreographer`, hit-test przez RN-owy `TouchTargetHelper` + IME jako overlay, tap przez `MotionEvent` → `decorView.dispatchTouchEvent`, tekst przez `InputConnection.commitText`, reload.
- `ios/ProbeSpike/ProbeAgent.m` to natywny agent iOS (start przez `+load`, `NSURLSessionWebSocketTask`): `viewWithTag`, `hitTest:`, stabilność na `presentationLayer`, reload przez `RCTTriggerReloadCommandListeners`. Bez syntezy dotyku.
- `ios/ProbeSpikeUITests/` zawiera pomiary Q4 (XCUITest).
- `probe/runner/probe.mjs` to runner: serwer WS, `getByRole/Text/Label`, `tap`, `fill`, `expect().toBeVisible()`, actionability loop z retry na `commit | 1 klatka`.

## 2. Kryterium fazy 0 (Android)

`probe/run-android.sh --build probe/runner/login-loop.mjs 100`:

```
passed 100/100, 128 s, 1.28 s/iterację (w tym 100–600 ms fake network + 350 ms animacji)
```

| Krok | mediana | p95 | 1. próba | na co czekał (liczba retry) |
|---|---|---|---|---|
| fill E-mail | 53 ms | 93 ms | 80% | `not mounted natively` ×20 |
| fill Hasło | 102 ms | 151 ms | 100% | — |
| tap Zaloguj | 104 ms | 173 ms | 48% | `disabled` ×55 |
| expect „Cześć, Ala” | 453 ms | 658 ms | — | (fake network) |
| tap Wyloguj | 544 ms | 718 ms | 0% | `not stable` ×402, `covered by ReactViewGroup` ×342 |

Narzut drivera, gdy element był gotowy od razu:

| | total | query (JS) | check (natywnie) | input |
|---|---|---|---|---|
| tap (n=48) | **95** / p95 166 | 17 / 53 | 38 / 82 | 34 / 68 |
| fill (n=180) | **76** / p95 141 | 6 / 33 | 20 / 58 | 43 / 91 |

Wnioski:
- **Actionability robi dokładnie to, co miała.** „Wyloguj” czekał na koniec animacji z native driverem i na zniknięcie toastu, „Zaloguj” na `enabled`. Wszystko bez sleepów i bez flaków. Każdy retry ma czytelny powód.
- `not mounted natively` (×20) to stan, w którym JS ma już zcommitowany element, a natywny widok jeszcze nie istnieje. To empiryczne potwierdzenie, że sam pomiar z JS nie wystarcza (zob. Q5).
- Podłoga ~1 klatki w `check` jest nieunikniona (stabilność w 2 klatkach). p95 psują głównie zajęty main thread (animacja klawiatury IME) i zajęty wątek JS (re-render po wpisaniu tekstu). To w dużej mierze realne czekanie na aplikację, a nie koszt drivera. Emulator jest tu wolniejszy od urządzenia.
- Możliwe optymalizacje, jeszcze nie zrobione: `waitActionable` po stronie agenta zamiast round-tripów runner↔JS↔native (doc 5.4), `fill` w jednym RPC (tap + focus + tekst), batching query + check.

## 3. Pytania z sekcji 8.2

### Q1. Tag widoku natywnego == tag host instance w JS? **Tak, na obu platformach.**

`stateNode.canonical.nativeTag` == `findNodeHandle()` == Android `View.id` == iOS `UIView.tag`. Prostokąty JS i natywne są zgodne co do ułamka punktu.
- Hit-test zwraca widok **w głąb** elementu: tekst wewnątrz Pressable, a na iOS wewnętrzny `RCTUITextField` z `tag = 0` wewnątrz `RCTTextInputComponentView`. Dlatego „isSameOrDescendant” musi iść łańcuchem przodków i porównywać ze zbiorem `{tag elementu} ∪ tagi potomków`. Zaimplementowane, działa.
- **Nie sprawdzone:** element spłaszczony przez view flattening (brak natywnego widoku). Pressable z `accessible` nie jest spłaszczany. Zbiór tagów potomków powinien to pokryć, ale trzeba to przetestować na `View` bez stylu.

### Q2. Reload `ReactHost` w Release? **Działa bez dodatkowych flag.**

- Android: `reactHost.reload("probe")`. Task kończy się w 29 ms, agent JS wraca po 77 ms, ekran logowania jest gotowy po 81 ms, a pełny flow logowania przechodzi po reloadzie.
- iOS: `RCTTriggerReloadCommandListeners(@"probe")` (`RCTHost` jest listenerem). Ekran gotowy po ~30 ms, licznik commitów od nowa.
- **Nie sprawdzone:** natywne singletony i czyszczenie storage/keychain (to faza 1, tryb `context`).

### Q3. Renderer w Release a `__REACT_DEVTOOLS_GLOBAL_HOOK__`? **Rejestruje się.**

`ReactFabric-prod.js` wywołuje `hook.inject()` (`bundleType: 0`) oraz `onCommitFiberRoot` przy każdym commicie, pod warunkiem że hook istnieje **przed załadowaniem renderera**. Osobny entry `index.e2e.js` z agentem jako pierwszym importem to zapewnia na obu platformach. **Deweloperski bundle Reacta nie jest potrzebny.**

### Q4. Latencja tapu przez XCTest (symulator)? **250–335 ms. Za dużo na budżet 100 ms.**

| Metoda | mediana | p95 | dostarczone |
|---|---|---|---|
| `XCUICoordinate.tap()` (publiczne API) | 334 ms | 352 ms | 60/60 |
| `XCUIElement.tap()` (z lookupem; małe drzewo) | 323 ms | 336 ms | ✓ |
| bezpośredni `eventSynthesizer` (prywatne API XCTest, jak WDA) | 254 ms | 259 ms | 50/50 |
| syntezator fire-and-forget (bez czekania na ack) | — | — | **nie dostarczone w 30 s** |
| pierwszy lookup elementu (snapshot) | ~1.1 s | | |

- Czas idzie na pipeline `testmanagerd` i czekanie na quiescence. Ominięcie quiescence daje tylko ~80 ms zysku, a zdarzeń nie da się pipeline'ować.
- Hybryda jest **poprawna** (100% tapów dotarło), tylko wolna. Na iOS daje ~0.3 s/tap. To wciąż szybciej niż Appium/Maestro z lookupem drzewa (~1 s+ samego snapshotu), ale nie „Playwright-fast”.
- Okno wyścigu między `waitActionable` a tapem (doc 5.4) wynosi ~250 ms, a nie kilka ms. Przy animacjach to realne ryzyko.

### Q5. `getBoundingClientRect` / `measureInWindow`: drzewo zmontowane czy zcommitowane? **Zcommitowane (shadow tree).**

10 przełączeń layoutu, pomiar w callbacku `onCommitFiberRoot`, równolegle próbkowanie natywnego widoku co klatkę:
- `getBoundingClientRect` (sync) i `measureInWindow` (callback po 0.1–0.25 ms) zwracają **nowy** layout od razu w momencie commitu i są ze sobą zgodne.
- Natywny widok ma nowy layout dopiero **~16 ms później** (mediana 16.3, max 17.7; zawsze pierwsza klatka po commicie).
- Konsekwencje dla projektu:
  1. Pomiar JS wyprzedza ekran o ~1 klatkę. Tap po współrzędnych z JS tuż po commicie może trafić w stary układ, więc **`check` i `point` muszą pochodzić z pomiaru natywnego** (tak jest zrobione).
  2. Transformy z native drivera (Animated/Reanimated) nie są widoczne w JS (`getBoundingClientRect` pokazywał `translateX: 400` jeszcze w trakcie animacji). Pierwotna „widoczność = w viewport wg JS” dawała zawyżone czasy `expect`. Przyjęto semantykę Playwrighta: **visible = niepusty box z JS**, a viewport, overlap i ruch rozstrzyga natywny check.
  - Zastrzeżenie: zegary JS (`performance.now`) i natywny (`System.nanoTime`) kalibrowane przez RPC, rozrzut ~5 ms, czyli wystarczająco przy granulacji klatki.

## 4. Znaleziska spoza listy 8.2

1. **Android Release blokuje cleartext `ws://`.** Agent milczy bez błędu. Wariant E2E potrzebuje `network_security_config` z cleartextem **tylko dla `localhost`** (`res/xml/probe_network_security.xml`). iOS ma `NSAllowsLocalNetworking` w szablonie, więc tam działa.
2. **Dwa niezależne WebSockety (JS + natywny) to dobry podział.** Natywny agent odpowiada nawet wtedy, gdy wątek JS jest zajęty, i nie potrzeba TurboModule ani codegenu do mostu JS↔native.
3. **Protokół potrzebuje identyfikacji sesji.** (a) Runner złapał stary proces aplikacji tuż przed jego zabiciem i RPC wisiało bez końca. Naprawione: reject pending przy rozłączeniu + timeout RPC. (b) Apka z emulatora i symulatora dzwoniły na ten sam port. → `Agent.hello` musi nieść token sesji/urządzenia z launch args (zgodne z doc 5.1, ale to jest **wymóg**, nie opcja).
4. Wpisywanie przez `InputConnection.commitText` działa z kontrolowanym `TextInput` (onChangeText → setState).
5. Hit-test na Androidzie przez `TouchTargetHelper` (ta sama logika co dispatch dotyku RN, respektuje `pointerEvents`) to publiczna klasa, ale wewnętrzna w duchu. Ryzyko przy upgrade'ach RN. Klawiatura (osobne okno) jest liczona osobno przez insety IME. **Nie przetestowano** przypadku przykrycia klawiaturą ani `Modal` (osobne okno).
6. iOS: „klatka” w `Action.check` to timer, a nie vsync (`ponytail:` w kodzie). Jeśli stabilność okaże się flaky, trzeba przejść na `CADisplayLink`.

## 5. Rekomendacja: co dalej

1. **Spike iOS tap (2–3 dni) przed MVP**, bo to jedyna otwarta decyzja architektoniczna:
   - (a) wstrzykiwanie HID na **symulatorze** (podejście idb/`simulator-server`, którego używa argent). CI i tak chodzi na symulatorach. Zmierzyć latencję i dostarczalność.
   - (b) synteza `UITouch` w procesie (KIF/EarlGrey) **tylko w wariancie E2E** + strażnik CI. Zmierzyć latencję i kruchość na iOS 26.
   - (c) fallback: hybryda XCTest (zmierzona tu, ~254 ms) dla realnych urządzeń.
   - Kryterium: tap < 50 ms, 100% dostarczonych, działa z Gesture Handler.
2. **Faza 1 na Androidzie może ruszać.** Najpierw przenieść `waitActionable` do agenta (mniej round-tripów, cel p95 < 100 ms), potem `fill` w jednym RPC, token sesji w handshake, test view flattening, `Modal` i klawiatury.
3. Wpiąć separację wariantów (build type `e2e`, konfiguracja `E2E`). W spike'u agent i entry są w głównym buildzie.

## 6. Reprodukcja

```bash
cd ProbeSpike
# Android (emulator-5554): build release + 100 iteracji / pytania 8.2
probe/run-android.sh --build probe/runner/login-loop.mjs 100
probe/run-android.sh probe/runner/questions.mjs

# iOS (symulator): build Release + UI testy
cd ios && xcodebuild build-for-testing -workspace ProbeSpike.xcworkspace -scheme ProbeSpike \
  -configuration Release -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath build/dd CODE_SIGNING_ALLOWED=NO
# Q1–Q3: zainstaluj build/dd/Build/Products/Release-iphonesimulator/ProbeSpike.app, potem:
node ../probe/runner/questions-ios.mjs   # i uruchom apkę (Android musi być zatrzymany: wspólny port 9123)
# Q4:
xcodebuild test-without-building ... -only-testing:ProbeSpikeUITests   # grep PROBE_Q4
```
