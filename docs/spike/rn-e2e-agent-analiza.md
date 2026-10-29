# Testy E2E w React Native: co jest zepsute u podstaw i jak to naprawić pluginem

*Analiza architektoniczna + projekt hipotetycznego narzędzia (roboczo: **Probe**). Stan wiedzy: październik 2026.*

---

## 0. TL;DR

1. **Najbardziej zepsutym elementem testowania mobilnego jest warstwa automatyzacji (driver)**, czyli kanał, przez który test obserwuje aplikację, czeka na nią i nią steruje. Build, CI, emulatory i backend też kosztują, ale te problemy rozwiązuje się pieniędzmi, cache'em i dyscypliną. Problem drivera jest architektoniczny.
2. Web jest szybki i stabilny, bo przeglądarka ma **wbudowany, wersjonowany protokół automatyzacji działający wewnątrz silnika** (CDP / WebDriver BiDi). Mobile go nie ma: narzędzia czytają drzewo accessibility z innego procesu (wolno) i zgadują gotowość aplikacji (flaky) albo podpinają się pod prywatne wnętrzności RN (kruche).
3. Idealnie ten protokół powinien istnieć w rdzeniu React Native. **W praktyce ~80–90% jego wartości da się zbudować jako zewnętrzny plugin**, bez zmian w RN core i bez ryzyka dla buildów produkcyjnych.
4. Warunek: trzeba przyjąć **model synchronizacji Playwrighta** (lokalna gotowość elementu + asercje z auto-retry), a **nie model Detoxa** (globalne „czy aplikacja jest idle”). Model Playwrighta wymaga tylko layoutu, hit-testu i licznika klatek, a to są publiczne API. Model Detoxa wymaga prywatnych hooków i pęka przy każdym wydaniu RN.
5. Plugin to: **agent w aplikacji** (JS + natywne moduły iOS/Android) + **runner w Node** z API w stylu Playwrighta + **cienki driver systemowy** do rzeczy spoza procesu aplikacji (dialogi uprawnień, na iOS także sam tap).
6. Produkcja jest bezpieczna dzięki: osobnemu entry pointowi JS, natywnemu kodowi linkowanemu tylko w wariancie testowym, wariantowi testowemu opartemu na Release i strażnikowi w CI, który skanuje artefakty produkcyjne.
7. Szacunek: **MVP ~1–2 miesiące** pracy doświadczonej osoby znającej iOS i Androida; wersja dojrzała **~6+ miesięcy**. Najtrudniejsze: synteza dotyku na iOS i natywne animacje.

---

## 1. Diagnoza: dlaczego mobile jest wolne i flaky, a web nie

### 1.1. Porównanie warstwa po warstwie

| Warstwa | Web (Playwright + przeglądarka) | Mobile RN dziś |
|---|---|---|
| Odczyt UI | DOM czytany w procesie silnika, mikrosekundy | Snapshot drzewa accessibility z innego procesu (XCTest / UiAutomator) przez HTTP/gRPC; na dużej aplikacji rzędu sekund |
| Gotowość do akcji | Silnik wie, czy element jest widoczny, stabilny, nieprzykryty, włączony | Polling z zewnątrz (Appium, Maestro) albo prywatne hooki do RN (Detox) |
| Wstrzykiwanie zdarzeń | Natywny pipeline inputu przeglądarki | XCTest / UiAutomator z zewnątrz |
| Sieć | Wbudowane przechwytywanie (`page.route`) | Brak; mock serwer albo podmiana modułu w buildzie |
| Izolacja testów | Nowy browser context w milisekundach | Reinstalacja, czyszczenie danych, erase symulatora: sekundy do minut |
| Środowisko | Headless, Linux, setki instancji | Pełny system w VM; iOS tylko na macOS |
| Kontrakt | Wersjonowany protokół utrzymywany przez producenta | Brak; narzędzia pękają przy upgrade'ach RN i Xcode |

### 1.2. Cztery przyczyny źródłowe

**a) Obserwacja UI jest wolna z samej konstrukcji.** XCUITest nie widzi widoków aplikacji, tylko drzewo accessibility, o które prosi z innego procesu. Dokumentacja Appium XCUITest Driver opisuje snapshot całej hierarchii jako operację kosztowną czasowo. Dokumentacja integracji Maestro w Software Mansion podaje rząd ~5 s na jedno pobranie hierarchii w dużej aplikacji. Apple nie dostarcza żadnego oficjalnego serwera automatyzacji dla narzędzi zewnętrznych; cały ekosystem iOS stoi na WebDriverAgent lub jego odpowiednikach.

**b) Driver nie wie, kiedy aplikacja jest gotowa.** To właściwe źródło flakiness. Playwright przed każdą akcją sprawdza widoczność, stabilność (ten sam bounding box przez dwie kolejne klatki), to, czy element odbiera zdarzenia (hit-test, a nie overlay), i to, czy jest włączony. Robi to od środka silnika. Na mobile:
- Appium i Maestro zgadują gotowość z zewnątrz, pollingiem i timeoutami;
- Detox ma wiedzę z wnętrza, ale zdobywa ją przez prywatne pola RN, więc pęka przy wydaniach RN (np. błędy synchronizacji z Fabric na Androidzie w 2026);
- Shopify, żeby osiągnąć stabilność, zbudował OCR i computer vision nad Appium, bo drzewu elementów nie dało się ufać.

**c) Wiedza o stanie aplikacji istnieje, ale nie jest wystawiona.** RN mówi protokołem CDP (React Native DevTools → Metro inspector proxy → Hermes), ale według oficjalnego trackera `cdpstatus.reactnative.dev` implementuje ok. 7% CDP (10 z 55 domen), i to domeny debugowania. Odpowiedników domen DOM, Input i Fetch, na których stoi Playwright, nie ma.

**d) Izolacja jest droga.** Browser context w Playwright powstaje w kilka milisekund. Na mobile reset to reinstalacja albo erase; zimny boot symulatora iOS to ~30–60 s. Zespoły piszą więc długie, zależne od siebie scenariusze, co mnoży flakiness.

### 1.3. Co byłoby rozwiązaniem „idealnym”

1. **Protokół automatyzacji w rdzeniu RN** (query z Fabric, sygnał gotowości z renderera, actionability, przechwytywanie sieci, tanie konteksty). Usuwa źródło flakiness.
2. **Headless runtime RN dla aplikacji.** Meta ma już **Fantom**: headless testy integracyjne na prawdziwym Hermesie, Fabric i TurboModules, bez symulatora, ale jako eksperymentalne narzędzie do testowania samego RN. Wyprodukowany dla aplikacji usunąłby źródło powolności dla większości testów.
3. **Na urządzeniu zostaje mała warstwa black-box** dla rzeczy naprawdę systemowych.

Ten dokument skupia się na punkcie 1 i na tym, **ile z niego da się zrobić samemu, jako plugin**.

---

## 2. Czy da się to zrobić jako plugin? Tak, z jednym warunkiem

### 2.1. Kluczowa decyzja: lokalna actionability zamiast globalnego „idle”

| | Model Detoxa | Model Playwrighta |
|---|---|---|
| Pytanie | Czy **cała aplikacja** jest bezczynna? | Czy **ten element** jest gotowy do **tej akcji**? |
| Potrzebna wiedza | Kolejka JS, timery, sieć, mounty Fabric, animacje, scheduler | Layout, hit-test, licznik klatek |
| Źródło wiedzy | Prywatne wnętrzności RN | Publiczne API RN i platform |
| Porażka | Shimmer / polling ⇒ aplikacja nigdy nie jest idle ⇒ test wisi | Element się animuje ⇒ test czeka na ten element, reszta aplikacji nie ma znaczenia |
| Odporność na upgrade RN | Niska | Wysoka |

Plugin powinien implementować model Playwrighta. Globalne idle może istnieć, ale **wyłącznie jako podpowiedź przyspieszająca**, nigdy jako warunek poprawności: jeśli ta część się zepsuje, testy mają działać dalej, tylko wolniej.

### 2.2. Wykonalność element po elemencie

| Element | Jak w pluginie | Stabilność API | Ocena |
|---|---|---|---|
| Transport | Własny WebSocket; aplikacja łączy się do runnera | Pełna kontrola | Łatwe |
| Query drzewa | `__REACT_DEVTOOLS_GLOBAL_HOOK__` + host instances | Półpubliczne, stabilne od lat | Łatwe / średnie |
| Layout | `measureInWindow`, na nowszych RN `getBoundingClientRect` | Publiczne | Łatwe |
| Actionability | Pomiar w 2 klatkach (JS + natywnie) + natywny hit-test | Publiczne API platform | Średnie |
| Input Android | `MotionEvent` → `dispatchTouchEvent` na root view | Publiczne | Średnie |
| Input iOS | Syntetyczny `UITouch` w procesie (prywatne API, tylko wariant E2E); fallback: HID z hosta (symulator) lub XCTest (urządzenie) | Prywatne API kruche, ale zmierzone na iOS 26.1 (faza 0b) | Średnie / trudne |
| Sieć JS | Owinięcie `XMLHttpRequest` (na nim stoi `fetch`) i `WebSocket` | Publiczne | Łatwe |
| Sieć natywna | `NSURLProtocol` (iOS), interceptor OkHttp (Android) | Publiczne | Średnie |
| Izolacja | Czyszczenie sandboxu (w tym keychain) + reload instancji React | Częściowo publiczne | Średnie, z ograniczeniami |
| Globalne idle | Śledzenie timerów/XHR w JS; opcjonalny mount hook Fabric w C++ | Wewnętrzne | Tylko podpowiedź |
| UI systemowe | Poza procesem aplikacji | n/d | Wymaga zewnętrznego drivera |

---

## 3. Architektura narzędzia

### 3.1. Komponenty

```
┌──────────────────────── Runner (Node) ────────────────────────┐
│  API testów (locators, auto-wait, expect z retry, route)      │
│  Zarządzanie urządzeniami i kontekstami, tracing, raporty     │
│  Serwer WebSocket (JSON-RPC)                                   │
└──────────────┬───────────────────────────────┬────────────────┘
               │ WS (protokół Probe)           │ system driver
               ▼                               ▼
┌──────── Agent w aplikacji (tylko build E2E) ────────┐  ┌── Driver systemowy ──┐
│ JS: hook DevTools, silnik query, actionability(JS), │  │ iOS: mini XCUITest   │
│     patch XHR/WS, tracker timerów, klient WS         │  │  (tap po współrz.,   │
│ Natywny iOS/Android: pomiar natywny, hit-test,       │  │  dialogi systemowe)  │
│     input (Android), NSURLProtocol / OkHttp,         │  │ Android: UiAutomator │
│     reset storage, reload ReactHost                  │  │  (dialogi systemowe) │
│ C++ (opcjonalnie): mount hook Fabric                 │  └──────────────────────┘
└──────────────────────────────────────────────────────┘
```

### 3.2. Struktura pakietów

```
probe/
  packages/
    agent-js/          # hook DevTools, query engine, network patch, timers, ws client
    agent-ios/         # Swift/ObjC: measure, hitTest, stability, NSURLProtocol, reset, reload
    agent-android/     # Kotlin: measure, hitTest, MotionEvent, Choreographer, OkHttp, reset, reload
    agent-cpp/         # (opcjonalny) Fabric mount/commit hook → zdarzenia aktywności
    runner/            # @probe/test: API, locators, expect, fixtures, trace, CLI
    system-driver-ios/ # minimalny XCUITest runner: tap(x,y), alerty, uprawnienia
    system-driver-android/ # UiAutomator: dialogi systemowe, powiadomienia
    expo-plugin/       # config plugin: wariant E2E, entry point, Podfile/gradle
    ci-guard/          # skaner artefaktów produkcyjnych
```

### 3.3. Query: drzewo z hooka React DevTools

- Przed pierwszym importem `react-native` agent instaluje globalny `__REACT_DEVTOOLS_GLOBAL_HOOK__`. Renderer RN rejestruje się w nim i przy każdym commicie wywołuje `onCommitFiberRoot`.
- Agent trzyma referencje do korzeni i na żądanie przechodzi drzewo fiberów: komponenty, propsy (`testID`, `accessibilityLabel`, `accessibilityRole`, `accessibilityState`, `role`, `aria-*`), tekst dzieci, host instances.
- Na tym budowane są lokatory semantyczne w stylu Testing Library: rola + nazwa dostępna, tekst, etykieta, `testID` (jako opcja, nie domyślnie).
- Zdarzenie commitu służy runnerowi jako sygnał „warto spróbować ponownie”, więc retry nie jest ślepym pollingiem.
- Warunek: hook musi istnieć przed załadowaniem Reacta. Najczyściej przez osobny entry point (`index.e2e.js`) albo `getModulesRunBeforeMainModule` w Metro.

### 3.4. Actionability: algorytm

Dla `tap(locator)` (inne akcje analogicznie, z innym zestawem sprawdzeń):

```
deadline = now + timeout
loop:
  el = resolve(locator)                     # z drzewa fiberów, zawsze od nowa
  if !el:              wait(nextCommit | 1 frame); continue
  if count(el) > 1:    fail("strict mode: N elementów")      # jak Playwright
  if !visible(el):     wait(nextCommit | 1 frame); continue  # niezerowy rozmiar, nie display:none,
                                                             # w obszarze okna (po scrollIntoView)
  if !enabled(el):     wait(nextCommit); continue            # accessibilityState.disabled, disabled, editable
  b1 = measureJS(el);    n1 = measureNative(el)
  waitFrames(1)
  b2 = measureJS(el);    n2 = measureNative(el)
  if b1 != b2 or n1 != n2: continue                          # animacja (także native driver / Reanimated)
  p = center(n2)
  hit = nativeHitTest(p)
  if !isSameOrDescendant(hit, el.nativeView): continue      # overlay, toast, modal, klawiatura
  inject(tap at p)
  return
until now > deadline → TimeoutError z diagnozą ostatniego niespełnionego warunku
```

Uwagi:

- **Pomiar natywny jest obowiązkowy.** Animacje z native driverem Animated i Reanimated zmieniają widok na wątku UI z pominięciem Reacta, więc sam pomiar z JS może pokazywać stan sprzed animacji. iOS: porównanie `layer.presentation()` z modelem warstwy; Android: frame `View` w dwóch kolejnych klatkach `Choreographer`.
- **Mapowanie elementu na natywny widok.** W Fabric host instance ma tag widoku; natywnie widok trafiony hit-testem można porównać z tym tagiem, idąc w górę hierarchii. *Do zweryfikowania na docelowej wersji RN* (patrz sekcja 8).
- **Błąd ma być diagnostyczny:** „element znaleziony, widoczny, włączony, ale przykryty przez `RCTModalHostView` w punkcie (180, 412)”. To ogromna część wartości narzędzia.

### 3.5. Input

- **Android:** `MotionEvent` (DOWN/MOVE/UP z realistycznymi odstępami czasu) wysyłany przez `dispatchTouchEvent` na root view aktywnego okna. Publiczne API; dotyk przechodzi przez normalny pipeline, więc natywne gesty (Gesture Handler) go widzą. Ograniczenie: tylko okna własnego procesu.
- **iOS, wariant domyślny (od fazy 0b): synteza `UITouch` w procesie** przez prywatne API (jak KIF / EarlGrey), kompilowana tylko w wariancie E2E i pilnowana strażnikiem CI (**nigdy** nie może trafić do App Store). Zmierzone na symulatorze iOS 26.1: tap → commit JS ~6 ms, 100/100, działa z RNGH (tap i pan). Szczegóły: `spike-ios-tap-wyniki.md`.
- **iOS, fallback na symulatorze:** HID z hosta przez stały proces (`idb_companion` / własny helper na SimulatorKit), ~17 ms do commitu JS. Potrzebny też do UI spoza procesu (alerty, uprawnienia).
- **iOS, fallback na urządzeniu:** hybryda XCTest (`XCUICoordinate`): współrzędne i gotowość liczy agent, tap wykonuje runner XCUITest. Poprawna, ale ~254–334 ms na tap (faza 0, Q4).
- **Tekst:** wpisywanie przez natywny input (iOS: `insertText` na pierwszym responderze; Android: `InputConnection` / zdarzenia klawiszy), nie przez ustawienie propsa `value`.
- **Antywzorzec:** wywoływanie `onPress` z JS (jak `fireEvent` w RNTL). Omija hit-testing i natywne gesty, więc test przechodzi tam, gdzie użytkownik by nie kliknął.

### 3.6. Sieć

- **JS:** owinięcie `XMLHttpRequest` (na nim stoi `fetch` w RN) i `WebSocket` przed startem aplikacji. Daje odpowiednik `page.route`: mock, opóźnienie, błąd, nagranie, asercje na requestach.
- **Natywna:** Android: interceptor w kliencie OkHttp używanym przez moduł sieciowy RN (RN pozwala podmienić fabrykę klienta); iOS: rejestracja `NSURLProtocol`, a dla sesji z własną konfiguracją podmiana `protocolClasses` w `URLSessionConfiguration`. Pokrywa obrazki i większość natywnych SDK.
- **Poza zasięgiem:** SDK z własnymi, zamkniętymi klientami HTTP. Zwykle to analityka, którą w testach i tak się wyłącza.

### 3.7. Izolacja: „app contexts”

1. Agent czyści sandbox w procesie: Documents, Library, Caches, SharedPreferences, pliki MMKV, bazy SQLite, **keychain** (na iOS przeżywa reinstalację, więc tu plugin jest lepszy od reinstalacji).
2. Reload instancji Reacta przez natywny `ReactHost` (bridgeless).
3. Runner wstrzykuje stan startowy: launch args, feature flagi, seed danych, deep link.

**Ograniczenie:** reload JS nie resetuje natywnych singletonów (SDK zainicjalizowane przy starcie procesu, cache, statyki). Dlatego dwa tryby:

| Tryb | Co resetuje | Koszt | Kiedy |
|---|---|---|---|
| `context` (domyślny) | JS + storage + keychain | ~sekunda | Większość testów |
| `relaunch` | Cały proces aplikacji | kilka sekund | Testy dotykające natywnego stanu |

Biblioteki i moduły aplikacji mogą dodatkowo zarejestrować hook `resetForTests()`.

### 3.8. Globalne idle jako podpowiedź

- Licznik aktywnych timerów i requestów (z owiniętych globali), z możliwością oznaczenia ich jako ignorowanych (polling, heartbeat, zapętlone animacje).
- Opcjonalnie mount hook w UIManagerze Fabric (C++), z którego korzystają też biblioteki takie jak Reanimated.
- Zastosowanie: szybsze ruszenie po nawigacji, lepsze komunikaty błędów („czekam na 2 requesty: GET /me, GET /feed”). **Nie** warunek poprawności.

---

## 4. API runnera: jak wyglądałby test

### 4.1. Przykład

```ts
import { test, expect } from '@probe/test';

test.use({ context: { storage: 'clean', launchArgs: { featureFlags: { newCheckout: true } } } });

test('logowanie i przejście do koszyka', async ({ app }) => {
  // Sieć: mock na poziomie aplikacji, bez osobnego buildu i mock serwera
  await app.route('**/api/login', (route) =>
    route.fulfill({ status: 200, json: { token: 't', user: { name: 'Ala' } } }),
  );
  await app.route('**/api/cart', (route) => route.fulfill({ json: { items: [] } }));

  // Lokatory semantyczne; każda akcja ma wbudowane auto-wait (actionability)
  await app.getByLabel('E-mail').fill('ala@example.com');
  await app.getByLabel('Hasło').fill('sekret');
  await app.getByRole('button', { name: 'Zaloguj' }).tap();

  // Asercje z auto-retry: brak sleepów
  await expect(app.getByText('Cześć, Ala')).toBeVisible();

  await app.getByRole('tab', { name: 'Koszyk' }).tap();
  await expect(app.getByText('Koszyk jest pusty')).toBeVisible();

  // Asercja na ruchu sieciowym
  await expect(app.requests('**/api/cart')).toHaveCount(1);
});

test('uprawnienie do lokalizacji', async ({ app }) => {
  await app.getByRole('button', { name: 'Pokaż sklepy w pobliżu' }).tap();
  await app.system.permission('location').allow();   // driver systemowy
  await expect(app.getByRole('list', { name: 'Sklepy' })).toBeVisible();
});
```

### 4.2. Zasady API (wprost z lekcji Playwrighta i Shopify)

- **Lokatory, nie uchwyty.** Lokator jest rozwiązywany od nowa przy każdej akcji, więc odmontowanie i ponowne zamontowanie elementu nie psuje testu.
- **Strict mode:** akcja na lokatorze pasującym do wielu elementów jest błędem, a nie „bierze pierwszy”.
- **Brak `sleep` w API.** Jest `app.clock` do sterowania czasem (fake timers w JS aplikacji), ale nie ma usypiania testu.
- **Furtki są oznaczone.** `tap({ force: true })` pomija sprawdzenia; `getByTestId` istnieje, ale lint i review traktują go jako wyjątek.
- **Każda akcja zostawia ślad:** snapshot drzewa, zrzut ekranu, requesty i powód czekania w trace (odpowiednik Playwright Trace Viewer).
- **Konteksty jak fixture'y:** `test.use({ context })` deklaruje stan startowy; domyślnie każdy test dostaje świeży kontekst.

### 4.3. Szkic interfejsów

```ts
interface App {
  getByRole(role: Role, opts?: { name?: string | RegExp; exact?: boolean }): Locator;
  getByText(text: string | RegExp, opts?: { exact?: boolean }): Locator;
  getByLabel(label: string | RegExp): Locator;
  getByTestId(id: string): Locator;            // wyjątek, nie norma

  route(pattern: string | RegExp, handler: (r: Route) => Promise<void>): Promise<void>;
  requests(pattern: string | RegExp): RequestsQuery;
  clock: { install(): Promise<void>; tick(ms: number): Promise<void> };

  newContext(opts?: ContextOptions): Promise<void>;   // reset JS + storage
  relaunch(opts?: ContextOptions): Promise<void>;     // pełny restart procesu
  openURL(url: string): Promise<void>;                // deep link

  system: {
    permission(kind: 'location' | 'camera' | 'notifications' | string): { allow(): Promise<void>; deny(): Promise<void> };
    alert(): { accept(): Promise<void>; dismiss(): Promise<void> };
  };
  screenshot(opts?: { mask?: Locator[] }): Promise<Buffer>;
}

interface Locator {
  tap(opts?: ActionOptions): Promise<void>;
  longPress(opts?: ActionOptions & { duration?: number }): Promise<void>;
  fill(text: string, opts?: ActionOptions): Promise<void>;
  clear(opts?: ActionOptions): Promise<void>;
  swipe(direction: 'up' | 'down' | 'left' | 'right', opts?: ActionOptions): Promise<void>;
  scrollIntoView(opts?: ActionOptions): Promise<void>;
  within(parent: Locator): Locator;
  nth(i: number): Locator;
  filter(opts: { hasText?: string | RegExp; has?: Locator }): Locator;
}

type ActionOptions = { timeout?: number; force?: boolean };
```

---

## 5. Protokół agent ↔ runner

### 5.1. Transport i handshake

- **JSON-RPC 2.0 przez WebSocket.** Aplikacja łączy się **do** runnera (adres z launch args), więc w aplikacji nie otwiera się żaden port nasłuchujący. Android: `adb reverse`; symulator iOS współdzieli `localhost` z hostem.
- Pierwsza wiadomość od agenta:

```json
{ "jsonrpc": "2.0", "method": "Agent.hello", "params": {
  "protocolVersion": "1.0",
  "platform": "ios",
  "rnVersion": "0.84.1",
  "newArchitecture": true,
  "capabilities": ["tree", "layout.native", "input.native", "network.js", "network.native",
                   "context.reset", "activity.hints"]
}}
```

- Runner sprawdza zgodność wersji protokołu i **degraduje się łagodnie**: brak `activity.hints` oznacza wolniejsze, ale poprawne testy; brak `input.native` na iOS oznacza tap przez driver systemowy.

### 5.2. Domeny

| Domena | Komendy | Zdarzenia |
|---|---|---|
| `Agent` | `hello`, `ping`, `getCapabilities` | `disconnected` |
| `Tree` | `query(selector) → nodes`, `describe(nodeId)`, `snapshot() → drzewo do trace` | `committed { rootId, commitId }` |
| `Layout` | `measure(nodeId, { source: "js" \| "native" })`, `hitTest({ x, y }) → nodeId?`, `waitFrames(n)` | – |
| `Action` | `waitActionable(selector, checks, timeout) → { nodeId, point }`, `tap`, `longPress`, `swipe`, `type`, `clear`, `scrollIntoView` | – |
| `Input` | `dispatchTouches(sequence)`, `typeText(text)` (niski poziom) | – |
| `Network` | `enable(patterns)`, `fulfill(id, response)`, `continue(id, overrides?)`, `abort(id, reason)` | `requestPaused`, `requestFinished`, `requestFailed` |
| `Context` | `reset({ storage, keychain, js })`, `reload()`, `setLaunchState(state)` | `ready` |
| `Activity` | `getPending() → { timers, requests, mounts }`, `ignore(pattern)` | `busy`, `idle` (tylko podpowiedź) |
| `Clock` | `install()`, `tick(ms)`, `uninstall()` | – |
| `Trace` | `screenshot()`, `startScreencast()`, `stopScreencast()` | – |

### 5.3. Format selektora

```json
{
  "role": "button",
  "name": { "regex": "^Zaloguj$" },
  "within": { "role": "dialog", "name": "Logowanie" },
  "filter": { "hasText": "Zaloguj" },
  "nth": null,
  "includeHidden": false
}
```

Selektor jest rozwiązywany **po stronie agenta** (blisko danych, bez przesyłania całego drzewa), a `nodeId` jest ważny tylko do najbliższego commitu. Dlatego API wysokiego poziomu operuje na selektorach, a `nodeId` służy wyłącznie w obrębie jednej akcji.

### 5.4. Przykład wymiany dla `tap`

```
runner → Action.waitActionable { selector, checks: ["visible","enabled","stable","receivesEvents"], timeout: 10000 }
agent  ← (czeka na Tree.committed / klatki; po spełnieniu warunków)
agent  → { nodeId: 812, point: { x: 187.5, y: 640 } }
runner → Action.tap { nodeId: 812, point: { x: 187.5, y: 640 } }       # Android / iOS z syntezą
   lub   systemDriver.tap(187.5, 640)                                   # iOS w trybie hybrydowym
runner → Trace.screenshot, Tree.snapshot                                 # do trace
```

W trybie hybrydowym na iOS między `waitActionable` a tapem przez XCTest jest krótkie okno wyścigu. Agent minimalizuje je, potwierdzając stabilność tuż przed odpowiedzią, a runner po tapie weryfikuje, czy przyszedł commit lub zdarzenie dotyku w agencie. Jeśli nie, raportuje to w trace.

---

## 6. Integracja z aplikacją bez ryzyka dla produkcji

### 6.1. Cztery warstwy zabezpieczeń

1. **Osobny entry point JS.**

   ```js
   // index.e2e.js
   import '@probe/agent-js/install'; // MUSI być pierwszy: hook DevTools, patch XHR/WS, timery
   import './index';                 // zwykły entry aplikacji
   ```

   Bundle produkcyjny buduje się z `index.js`, który agenta nie zna. To silniejsze niż flagi `if (__E2E__)`, bo nie polega na dead code elimination.

2. **Natywny kod tylko w wariancie E2E.**
   - Android: osobny build type (np. `e2e`, `initWith release`) i zależność przez `e2eImplementation`.
   - iOS: osobna konfiguracja `E2E` skopiowana z `Release`; w Podfile `pod 'ProbeAgent', :configurations => ['E2E']`.
   - Autolinking RN CLI: wyłączenie automatycznego podpięcia agenta w `react-native.config.js`, żeby nie trafił do wszystkich wariantów.
   - Expo: config plugin aktywowany zmienną środowiskową (np. `PROBE_E2E=1`) w profilu buildu E2E.

3. **Wariant E2E jak najbliżej produkcji:** Release, Hermes bytecode, minifikacja; jedyna różnica to agent. Agent jest **pasywny**, dopóki runner się nie połączy (nie zmienia zachowania, nie loguje, nie trzyma zasobów).

4. **Strażnik w CI** dla każdego buildu produkcyjnego:

   ```bash
   # Przykład idei; nazwy symboli zależą od implementacji
   unzip -q -o app-release.aab -d /tmp/aab && \
     ! grep -rqa -e 'ProbeAgent' -e '__PROBE_AGENT__' /tmp/aab || { echo "Agent w buildzie produkcyjnym!"; exit 1; }
   unzip -q -o App.ipa -d /tmp/ipa && \
     ! grep -rqa -e 'ProbeAgent' -e '__PROBE_AGENT__' /tmp/ipa || { echo "Agent w buildzie produkcyjnym!"; exit 1; }
   ```

   Szczególnie ważne na iOS, jeśli używasz opcjonalnej syntezy dotyku na prywatnym API: taki kod w buildzie sklepowym to ryzyko odrzucenia.

### 6.2. Wymagania wobec aplikacji

- New Architecture (rekomendowane: tylko New Architecture, co upraszcza wszystko).
- Sensowne etykiety i role dostępności, bo na nich stoją lokatory. Efekt uboczny: lepsza dostępność aplikacji.
- Dostęp do „seedowania” stanu przez launch args (feature flagi, tryb mock, deep linki do ekranów).

---

## 7. Plan realizacji

| Faza | Zakres | Czas (szacunek) | Kryterium wyjścia |
|---|---|---|---|
| **0. Spike** | Hook DevTools + query + `measureInWindow` + tap na Androidzie przez `dispatchTouchEvent`; jeden ekran logowania | ~2 tygodnie | Logowanie przechodzi 100/100 razy bez sleepów; krok < 100 ms. **Zrobione 2026-10-27** (`spike-wyniki.md`): 100/100, mediana kroku < 100 ms, p95 ~140–170 ms |
| **0b. Spike tapu iOS** | Porównanie ścieżek tapu, bo tap przez XCTest okazał się za wolny (~254–334 ms): (a) wstrzykiwanie HID na symulatorze (podejście idb / `simulator-server`), (b) synteza `UITouch` w procesie tylko w wariancie E2E + strażnik CI, (c) hybryda XCTest jako fallback dla urządzeń fizycznych. Każdą zmierzyć na tym samym ekranie logowania i z Gesture Handler | 2–3 dni | Tap < 50 ms, 100% dostarczonych na 100 przebiegach, działa z natywnymi gestami; wybrana ścieżka domyślna dla symulatora i urządzenia. **Zrobione 2026-10-27** (`spike-ios-tap-wyniki.md`): synteza `UITouch` w procesie, tap → commit JS ~6 ms (p95 ~9), 100/100, RNGH tap + pan OK; urządzenie fizyczne niezweryfikowane |
| **1. MVP** | Pełne actionability (JS + natywnie), `fill`, `swipe`, `scrollIntoView`; mock sieci JS; `context` reset; iOS ze ścieżką tapu wybraną w fazie 0b; podstawowy trace | ~1–2 miesiące łącznie z fazą 0 | 10–20 realnych testów z aplikacji, stabilność ≥ 99% na 50 przebiegach |
| **2. Dojrzewanie** | Sieć natywna, driver systemowy (uprawnienia, alerty), `relaunch`, `clock`, równoległość, integracja z Expo i RN CLI, strażnik CI | +2–3 miesiące | Migracja większości istniejącego suite'u |
| **3. Odporność** | Adaptery animacji (Reanimated, Lottie), opcjonalny mount hook C++, macierz wersji RN w CI pluginu, Trace Viewer | +2–3 miesiące | Upgrade RN nie wymaga zmian w testach |

**Metryki, które warto mierzyć od pierwszego dnia:** mediana i p95 czasu kroku, odsetek udanych przebiegów per test (stabilność), czas od startu testu do pierwszej akcji, odsetek błędów z czytelną diagnozą.

---

## 8. Ryzyka i otwarte pytania

### 8.1. Ryzyka

| Ryzyko | Wpływ | Mitygacja |
|---|---|---|
| Synteza dotyku na iOS przez prywatne API psuje się z nową wersją iOS | Wysoki | Fallbacki zmierzone w fazie 0b: HID z hosta (symulator, ~17 ms) i XCTest (urządzenie, ~254 ms); macierz wersji iOS w CI pluginu; synteza tylko w wariancie E2E + strażnik CI |
| Animacje na wątku UI (Reanimated, Lottie, Skia) myli pomiar stabilności | Średni | Pomiar natywny warstwy prezentacji + adaptery per biblioteka |
| Reset kontekstu nie czyści natywnych singletonów | Średni | Tryb `relaunch`, hooki `resetForTests()` |
| Hooki C++ Fabric zmieniają się między wersjami RN | Niski (bo opcjonalne) | Tylko podpowiedź; macierz wersji w CI |
| Hook DevTools zmienia kształt drzewa fiberów | Niski | Te same zmiany musiałyby uwzględnić React DevTools; testy na kilku wersjach React |
| Wariant E2E rozjeżdża się z produkcją | Średni | Wariant oparty na Release, pasywny agent, strażnik CI |
| Okna i surface'y spoza głównego drzewa (Modal na iOS, natywne okna bibliotek) | Średni | Przechodzenie po wszystkich oknach i korzeniach; testy na typowych bibliotekach |

### 8.2. Do zweryfikowania w fazie 0 (moja analiza, nie sprawdzone empirycznie)

1. Czy w docelowej wersji RN tag widoku natywnego (iOS `view.tag`, Android `view.id`) jest zgodny z tagiem host instance po stronie JS w Fabric, co pozwala porównać wynik hit-testu z elementem.
2. Czy `ReactHost` pozwala na reload instancji w buildzie Release bez dodatkowych flag i jak zachowują się wtedy moduły natywne.
3. Czy renderer RN w buildzie produkcyjnym (Release) nadal rejestruje się w `__REACT_DEVTOOLS_GLOBAL_HOOK__`; jeśli nie, wariant E2E musi używać deweloperskiego bundla Reacta lub innego mechanizmu dostępu do korzeni.
4. Jakie są realne opóźnienia `XCUICoordinate.tap` w trybie hybrydowym na symulatorze w CI.
5. Czy `getBoundingClientRect` / `measureInWindow` zwracają layout z zamontowanego, czy tylko z zcommitowanego drzewa, i ile klatek opóźnienia trzeba doliczyć.

---

## 9. Wnioski

1. **Problem jest w driverze, nie w testach.** Dopóki test obserwuje aplikację z zewnątrz przez snapshoty accessibility albo podpina się pod prywatne wnętrzności RN, będzie albo wolny, albo kruchy. Cache buildów, sharding i lepsze CI tylko łagodzą objawy.
2. **Wiedza potrzebna do stabilnych testów jest dostępna publicznie,** jeśli zada się właściwe pytanie. „Czy ten element jest widoczny, stabilny przez dwie klatki, trafiany przez hit-test i włączony?” wymaga tylko layoutu, hit-testu i klatek. „Czy cała aplikacja jest idle?” wymaga prywatnych hooków. Playwright wygrał na webie właśnie tym przesunięciem pytania.
3. **Plugin jest realny i bezpieczny dla produkcji.** Agent w aplikacji (JS + natywnie), runner w Node z API w stylu Playwrighta i cienki driver systemowy dają ~80–90% wartości „idealnego” protokołu w core RN. Detox udowodnił, że model „agent tylko w wariancie testowym” działa operacyjnie; nowe narzędzie zmienia przede wszystkim model synchronizacji i źródło wiedzy.
4. **Granic nie przeskoczy plugin:** pełnej izolacji procesu jak w browser context, precyzyjnej wiedzy o schedulerze Reacta, natywnego stanu modułów i UI systemowego. Na iOS synteza dotyku działa (faza 0b), ale stoi na prywatnym API, więc zostaje słabym punktem; dlatego są dwa zmierzone fallbacki (HID z hosta, XCTest).
5. **Najlepsza kolejność:** najpierw spike na Androidzie (najtańszy dowód wartości), potem iOS z syntezą dotyku w procesie (faza 0b), potem sieć natywna i konteksty. Jeśli spike nie da kroków < 100 ms i 100/100 przebiegów, pomysł należy zweryfikować, zanim zainwestuje się w resztę.
6. **Długofalowo** ten sam protokół jest naturalnym kandydatem do włączenia w RN core (ewolucja obecnego CDP w React Native DevTools), a w połączeniu z headless runtime w stylu Fantom większość testów mogłaby w ogóle zejść z urządzeń.

---

## Źródła (z wcześniejszego researchu)

- Playwright: Auto-waiting / actionability – https://playwright.dev/docs/actionability
- Playwright README (browser contexts) – https://github.com/microsoft/playwright
- Appium XCUITest Driver: WebDriverAgent Slowness – https://appium.github.io/appium-xcuitest-driver/latest/guides/wda-slowness
- Software Mansion, integracja Maestro (czas pobrania hierarchii) – https://docs.swmansion.com/argent/docs/cloud/integrations/maestro/
- DeviceLab, architektura maestro-runner (brak oficjalnego serwera automatyzacji na iOS) – https://devicelab.dev/blog/maestro-runner-architecture
- Pokrycie CDP w React Native / Hermes – https://cdpstatus.reactnative.dev/devtools-protocol/tot
- Fantom (headless testy integracyjne RN) – https://deepwiki.com/facebook/react-native/7.1-fantom-integration-testing-framework
- React Native Harness (Callstack) – https://callstack.com/blog/introducing-react-native-harness-fast-real-device-testing-for-native-modules
- Android Emulator snapshots – https://developer.android.com/studio/run/emulator-snapshots
- Callstack simlock (pomiary bootu symulatorów i emulatorów) – https://github.com/callstackincubator/simlock/pull/62
- Shopify Engineering: mobile E2E stability 98% – https://shopify.engineering/mobile-e2e-testing
- Detox: issues dotyczące New Architecture (#4963, #4990, #4842) – https://github.com/wix/Detox/issues
