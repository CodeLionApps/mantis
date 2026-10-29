# Probe vs Detox vs Maestro — benchmark (Android, niżej iOS)

*Data: 2026-10-28. Ta sama aplikacja i **ten sam APK Release** dla wszystkich narzędzi (`ProbeSpike/`, RN 0.88.1, New Arch, Hermes, bridgeless, RNGH 3.4.0).
Emulator Android API 34 arm64 (`Detox_Emulator`, `-gpu host`), MacBook M1 Pro 16 GB, na baterii, load avg 4–7. Detox 20.51.4 + Jest, Maestro CLI 2.11.0, Probe ze spike'u (faza 0 + poprawki do benchmarku).*

## TL;DR

| Narzędzie | Czas całkowity (wall) | Średnia / test | p50 | p95 | max | Zaliczone |
|---|---|---|---|---|---|---|
| **Probe** | **614 s** (10 min) | **1.02 s** | **0.67 s** | **1.96 s** | **2.2 s** | **600/600 (100%)** |
| Detox (domyślnie) | 5155 s (86 min) | 8.58 s | 7.66 s | 15.5 s | 21.4 s | 589/600 (98.2%) |
| Detox (`--debug-synchronization 200`, obejście buga) | 2288 s (38 min) | 3.79 s | 2.69 s | 10.5 s | 15.5 s | 597/600 (99.5%) |
| Maestro | 5189 s za 47 iteracji → **~11 040 s (~3.1 h) na 100** (ekstrapolacja) | 18.1 s | 19.7 s | 26.0 s | 227 s | 261/282 (92.6%) |

- **Probe jest ~8× szybszy od domyślnego Detoxa, ~4× od Detoxa z obejściem i ~18× od Maestro** (średnia na test). Na medianie różnica do Maestro to ~30×.
- **Probe jest jedynym narzędziem bez porażki** (600/600). Detox i Maestro padają głównie na teście `list` (scroll do elementu).
- Czas Probe to w większości **czekanie na samą aplikację**: fake network 100–600 ms w `login`, 1–2 s w `loading`, animacje. `details` (2 asercje + tap) trwa 0.24 s, a `counter` (6 tapów + asercja) 0.44 s.

## Per test

Średnia / p50 / p95 / max w ms, w nawiasie zaliczone. Czas testu obejmuje reset stanu robiony idiomatycznie dla danego narzędzia.

| Test | Probe | Detox | Detox dbgsync | Maestro (47 iter.) |
|---|---|---|---|---|
| login | 1331 / 1310 / 1678 / 1777 (100/100) | 8659 / 8606 / 9059 / 21386 (97/100) | 3596 / 3555 / 3988 / 4379 (100/100) | 21225 / 21003 / 23066 / 29600 (47/47) |
| counter | 444 / 445 / 488 / 515 (100/100) | 7690 / 7628 / 7828 / 17440 (100/100) | 2651 / 2642 / 2735 / 2872 (100/100) | 15202 / 15185 / 15851 / 15917 (47/47) |
| list | 1831 / 1834 / 1858 / 1876 (100/100) | 15078 / 15019 / 16831 / 18636 (92/100) | 10462 / 10285 / 11631 / 15529 (97/100) | 30155 / 24789 / 32486 / 227438 (28/47) |
| details | 239 / 237 / 263 / 281 (100/100) | 5688 / 5965 / 7355 / 14372 (100/100) | 1187 / 991 / 1102 / 7417 (100/100) | 9575 / 7310 / 14150 / 49094 (46/47) |
| loading | 1746 / 1750 / 2186 / 2220 (100/100) | 7097 / 7141 / 7629 / 7733 (100/100) | 2116 / 2114 / 2564 / 2705 (100/100) | 9438 / 7963 / 9476 / 78479 (46/47) |
| form | 538 / 532 / 635 / 666 (100/100) | 7246 / 7682 / 7963 / 8403 (100/100) | 2720 / 2715 / 2811 / 2932 (100/100) | 23089 / 21962 / 26919 / 47019 (47/47) |

## Testy

Każdy test startuje z Menu ze świeżym stanem JS. Semantyka jest identyczna we wszystkich narzędziach. Nie ma sleepów ani retry.

1. `login`: 2× wpisanie tekstu, tap w przycisk aktywny dopiero po wypełnieniu pól, asercja po fake network, tap w przycisk wjeżdżający animacją i przykryty toastem, asercja.
2. `counter`: 6 tapów, asercja tekstu.
3. `list`: scroll FlatList do „Element 60”, tap, asercja.
4. `details`: nawigacja, 2 asercje, powrót, asercja widoczności i asercja niewidoczności.
5. `loading`: tap, czekanie 1–2 s na dane, asercja, asercja zniknięcia spinnera.
6. `form`: zamiana tekstu (clear + type), Switch, `Modal` (osobne okno), asercja, zamknięcie, asercja niewidoczności.

Kod:
- Probe: `bench/probe/bench.mjs`
- Detox: `e2e/bench.test.js`
- Maestro: `bench/maestro/flows/*.yaml`

## Reset między testami (idiomatyczny)

| | Mechanizm | Koszt (p50 / p95) |
|---|---|---|
| Probe | reload `ReactHost` przez natywnego agenta + czekanie na Menu | 46 / 88 ms |
| Detox | `device.reloadReactNative()` w `beforeEach` | zawiera ~5 s przestoju (niżej) |
| Maestro | `launchApp` na początku flow (stop + start procesu) | 241 / 1224 ms |

Reset nie tłumaczy różnic. Narzut leży w samych akcjach:
- **Maestro:** `tapOn` ma p50 **2.95 s**, p95 4.07 s (n = 1011). Każda akcja czeka na ustabilizowanie ekranu i pobiera hierarchię UiAutomatora.
- **Probe:** tap ~0.1 s (faza 0).

## Co psuje porównanie (uczciwie, w obie strony)

1. **Detox 20.51.4 stoi ~5 s po każdym reload/launch na New Arch.**
   - Prawdopodobnie gubi wybudzenie w idling resources, a Espresso sprawdza ponownie dopiero po 5 s ostrzeżenia.
   - To bug Detoxa, a nie cecha jego modelu, dlatego są dwa wiersze. `--debug-synchronization 200` go omija; uczciwe porównanie modelu to **Probe vs Detox dbgsync: ~3.7×**.
2. **`toBeVisible` w Probe ma semantykę Playwrighta** (niepusty box w drzewie JS). Detox wymaga ≥ 75% widoczności natywnie, Maestro „na ekranie”.
   - To lekko faworyzuje Probe. Przykład: „Cześć, Ala” jest widoczne już w trakcie wjazdu, a tekst w Modalu „znika” przed końcem fade-out.
   - Akcje (tap, fill) w Probe mają pełne actionability (stabilność, viewport, hit-test, fokus okna), więc nie dotyczy to akcji.
3. **Test `list` zależy od strategii scrolla.**
   - Probe przeciąga palcem powoli, bez flinga (~5 przeciągnięć).
   - Detox `whileElement().scroll(400)` daje 8% porażek: element jest widoczny w < 75% (ostatni scroll zostawia go przy krawędzi).
   - Maestro `scrollUntilVisible` z domyślnymi parametrami pada w **40%** („Element 60” przewinięty bez złapania).
   - Oba prawdopodobnie da się naprawić tuningiem (`centerElement: true`, mniejszy krok). Mierzone było idiomatyczne, domyślne użycie.
4. **Porażki `login` w Detox (3/100)** to crash RN 0.88 po reloadzie podczas wpisywania (`TextLayoutManager.kt:714`, `IllegalStateException`). To bug RN, nie Detoxa.
   - Probe też resetuje reloadem i w 600 wykonaniach go nie trafił.
   - Maestro restartuje proces, więc go nie dotyczy.
5. **Probe był wcześniej szkodliwy dla Detoxa.**
   - Pasywny agent JS ponawiał połączenie co 1000 ms, a Detox traktuje timery < 1500 ms jako „app busy” (login 86 s zamiast 9 s).
   - Poprawione: retry co 2000 ms. To wymóg dla agenta, bo ten sam build bywa testowany różnymi narzędziami.

## Przebieg kampanii i odrzucone dane

- Pierwsza kampania (noc 27→28.10) przerwana: Mac na baterii wszedł w idle sleep o 00:25 w trakcie Detoxa. Dane w `bench/results/interrupted-sleep-2026-10-28/`, **nie użyte**. `bench/run-all.sh` ma teraz `caffeinate -ims`.
- Druga kampania (28.10, 08:43–12:24), sekwencyjnie: Probe, Detox, Detox dbgsync, Maestro. W `pmset -g log` brak snu w tym oknie.
- **Maestro przerwany po 47 iteracjach.**
  - Od iteracji 47 (12:24) host mocno się zalagował (load avg 15 min = 86), a emulator pokazał dialog ANR „System UI isn't responding”. Dialog zasłaniał aplikację, więc każdy flow padał.
  - Użyte iteracje 0–46 (282 wykonania). Czasy per flow pochodzą z artefaktów debug Maestro (`commands.json`: timestamp + duration każdej komendy), bo junit nie powstał (`bench/maestro/from-debug.mjs`).
  - Wall time na 100 iteracji to ekstrapolacja liniowa.
- Iteracje 31–32 Maestro mają outliery (list 227 s i 104 s, details 49 s, loading 78 s). Wyglądają na wcześniejszy, krótszy lag hosta. Zostały w danych: p50 jest na nie odporne, a średnia Maestro bez nich to 16.6 s zamiast 18.1 s. Wniosek się nie zmienia.
- Detox i Probe skończyły przed lagiem.

## Wnioski

1. **Hipoteza z analizy potwierdzona na Androidzie.** Model Playwrighta (lokalna actionability w procesie aplikacji) jest jednocześnie najszybszy i najstabilniejszy: 100% zaliczonych testów i najwęższy rozrzut w obrębie testu (max/p50 ≤ 1.4 dla każdego testu).
2. **Największa różnica dotyczy kosztu pojedynczej akcji, nie resetu.**
   - Maestro płaci ~3 s za tap.
   - Detox płaci za globalne idle; nawet bez buga 5 s zostaje ~1–2.5 s na test ponad Probe.
   - Probe płaci ~0.1 s i czeka tylko na element, którego dotyczy akcja.
3. **Bug synchronizacji Detoxa na New Arch** (5 s po reloadzie) to dokładnie ryzyko opisane w analizie (sekcja 1.2b): model globalnego idle pęka przy zmianach RN.
4. Następny krok: powtórzyć na iOS, gdy Probe dostanie syntezę dotyku z fazy 0b (`spike-ios-tap-wyniki.md`), oraz dodać zaostrzone `toBeVisible` (viewport + natywny widok), żeby zamknąć punkt 2 z listy zastrzeżeń.

## Reprodukcja

```bash
cd ProbeSpike
emulator -avd Detox_Emulator -port 5554 -gpu host -no-snapshot-save &   # -gpu host! SwiftShader zawyża czasy
bench/build-android.sh                       # release APK + Detox androidTest APK
ANDROID_SERIAL=emulator-5554 bench/run-all.sh 100   # ~5 h; wyniki: bench/results/*.jsonl, SUMMARY.md
node bench/summarize.mjs probe detox detox-dbgsync maestro
# pojedynczo: bench/run-probe.sh N | bench/run-detox.sh N | bench/run-maestro.sh N
```

Szczegóły ustawień Detox i Maestro: `ProbeSpike/bench/NOTATKI-detox-maestro.md`.

---

# iOS (symulator), 10 iteracji na narzędzie

*Data: 2026-10-28, 13:33–13:57. Ten sam build Release `.app` dla wszystkich narzędzi. Symulator iPhone 17 Pro, iOS 26.1, Xcode 26.1.1. Detox 20.51.4, Maestro 2.11.0, Probe z syntezą `UITouch` w procesie (faza 0b).
**Maszyna mocno obciążona z zewnątrz:** load avg 25–50, pod koniec 120 (VS Code renderer ~120% CPU, indeksowanie Spotlight). Czasy bezwzględne są zawyżone; proporcje są wiarygodniejsze. Snu w trakcie nie było.*

| Narzędzie | Czas całkowity (wall) | Średnia / test | p50 | p95 | max | Zaliczone |
|---|---|---|---|---|---|---|
| **Probe** | **84 s** | **1.24 s** | **1.58 s** | **1.93 s** | **2.2 s** | **60/60** |
| Detox | 473 s | 7.75 s | 7.27 s | 16.4 s | 16.5 s | 60/60 |
| Maestro | 866 s | 14.1 s | 11.7 s | 26.7 s | 27.7 s | 60/60 |

- **Probe jest ~6× szybszy od Detoxa i ~11× od Maestro** (średnia na test). Wall time: 5.6× i 10.3×.
- Wszystkie trzy narzędzia przeszły 60/60. Przy 10 iteracjach to za mało, żeby mówić o różnicach w stabilności.
- Przy n = 10 na test p95 to praktycznie max.

Per test: średnia / p50 / p95 / max w ms (zaliczone):

| Test | Probe | Detox | Maestro |
|---|---|---|---|
| login | 1578 / 1514 / 2223 / 2223 (10/10) | 8254 / 7868 / 11692 / 11692 (10/10) | 14604 / 13954 / 19928 / 19928 (10/10) |
| counter | 502 / 500 / 529 / 529 (10/10) | 9934 / 9926 / 9992 / 9992 (10/10) | 10230 / 10037 / 11698 / 11698 (10/10) |
| list | 1785 / 1786 / 1813 / 1813 (10/10) | 16394 / 16370 / 16532 / 16532 (10/10) | 26726 / 26630 / 27658 / 27658 (10/10) |
| details | 180 / 180 / 197 / 197 (10/10) | 1528 / 1534 / 1568 / 1568 (10/10) | 6768 / 6727 / 7288 / 7288 (10/10) |
| loading | 1750 / 1772 / 2097 / 2097 (10/10) | 3248 / 2694 / 4137 / 4137 (10/10) | 8165 / 8017 / 8609 / 8609 (10/10) |
| form | 1615 / 1606 / 1645 / 1645 (10/10) | 7138 / 7115 / 7267 / 7267 (10/10) | 17840 / 17677 / 18803 / 18803 (10/10) |

## Co psuje porównanie na iOS

1. **Detox wymaga shimu w aplikacji.**
   - Detox 20.51.4 szuka `reactNativeFactory` na `AppDelegate`, a szablon RN 0.88 trzyma go w `SceneDelegate`. Bez shimu każdy `reloadReactNative()` crashuje („Invalid AppDelegate”).
   - Dodane dwie linie w `AppDelegate.swift` / `SceneDelegate.swift`, bez zmiany zachowania aplikacji. To zwykły krok integracji Detoxa z nowym szablonem.
2. **Bug synchronizacji Detox iOS na New Arch.**
   - DetoxSync zdejmuje timer JS ≤ 1.5 s dopiero przy `clearTimeout` albo po 1.5 s od utworzenia; nie widzi jego wykonania.
   - Każdy tap w `Pressable` uruchamia wewnętrzny timer RN (~120 ms), więc trzyma Detox przez ~1.5 s. Stąd `counter` (6 tapów) ≈ 10 s.
   - `--debug-synchronization` na iOS nie pomaga, więc nie ma wariantu „dbgsync”. To znów problem modelu globalnego idle (analiza, sekcja 1.2b).
3. **Pasywny agent Probe spowalniał Detox iOS — naprawione przed kampanią.**
   - Pierwsze `setTimeout(connect, 0)` agenta JS DetoxSync liczył jako busy przez ~1.5 s po każdym reloadzie.
   - Teraz pierwsza próba idzie przez `setImmediate`, a kolejne co 2000 ms. Smoke Detoxa przed poprawką: `details` 3.1 s, po: 1.5 s.
   - Wniosek dla agenta: **żadnych timerów < 1.5 s w trybie pasywnym** (Android i iOS).
4. **Maestro iOS:** `scrollUntilVisible` ma timeout 60 s, bo jeden krok scrolla trwa ~4 s i domyślne 20 s nie wystarcza (na Androidzie było domyślne 20 s). Typowe koszty komend:
   - tap ~1.6 s;
   - `inputText` ~1.3 s;
   - `launchApp` ~1.65 s;
   - start CLI ~15 s w wall time.
5. **Probe iOS:**
   - Tap trzymany 30 ms. Przy 8 ms (1 klatka przy 120 Hz) `UISwitch` w iOS 26 gubił tapy.
   - `form` jest wolniejszy niż na Androidzie (1.6 s vs 0.5 s): ~0.6 s to czekanie na koniec fade-in Modala (UIKit ignoruje wtedy dotyk), ~0.65 s to `toBeHidden`, bo RN na iOS trzyma zawartość Modala w drzewie do końca animacji zamknięcia. To koszt aplikacji i UIKit, nie narzędzia.
   - Ta sama łagodniejsza semantyka `toBeVisible` co na Androidzie.
6. **Klawiatura sprzętowa symulatora była podłączona** (bez klawiatury ekranowej) dla wszystkich narzędzi.

## Wnioski iOS

- Obraz jest ten sam co na Androidzie: Probe jest rząd wielkości szybszy od Maestro i kilkukrotnie od Detoxa.
- Detox na iOS pęka w innym miejscu niż na Androidzie (timery zamiast przestoju po reloadzie), ale z tej samej przyczyny: globalne idle zależy od wnętrzności RN.
- Do zrobienia: powtórka na cichej maszynie (`bench/run-all-ios.sh 10`, ~25 min) dla czasów bezwzględnych i więcej iteracji, żeby porównać stabilność.

Reprodukcja:

```bash
cd ProbeSpike/ios && xcodebuild build -workspace ProbeSpike.xcworkspace -scheme ProbeSpike -configuration Release \
  -destination 'id=068243DC-2498-4E45-9C09-CB332F1EB666' -derivedDataPath build/dd CODE_SIGNING_ALLOWED=NO
cd .. && SIM_UDID=068243DC-2498-4E45-9C09-CB332F1EB666 bench/run-all-ios.sh 10   # wyniki: bench/results-ios/
```
