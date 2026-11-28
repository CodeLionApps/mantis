// Spike app: a menu of small screens for the iOS tap spike and the Mantis/Detox/Maestro benchmark.
// Login is built to be hostile to naive E2E drivers: async "network", disabled-until-valid button,
// native-driver enter animation, a toast that briefly covers the next button.
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  BackHandler,
  FlatList,
  Image,
  Linking,
  Modal,
  NativeModules,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  requireNativeComponent,
} from 'react-native';
import { GestureDetector, GestureHandlerRootView, usePanGesture, useTapGesture } from 'react-native-gesture-handler';

function Button({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled && styles.buttonDisabled]}>
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

function Login({ onLogin, onBack }: { onLogin: (name: string) => void; onBack: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [taps, setTaps] = useState(0);
  const submit = () => {
    setBusy(true);
    // fake network: 100-600 ms
    setTimeout(() => onLogin(email.split('@')[0] === 'ala' ? 'Ala' : email), 100 + Math.random() * 500);
  };
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Logowanie</Text>
      <TextInput testID="email" accessibilityLabel="E-mail" placeholder="ala@example.com" style={styles.input} value={email} onChangeText={setEmail} autoCapitalize="none" />
      <Text nativeID="password-label" style={styles.body}>Hasło do konta</Text>
      <TextInput testID="password" accessibilityLabelledBy="password-label" placeholder="Hasło" style={styles.input} value={password} onChangeText={setPassword} secureTextEntry />
      <Button title={busy ? 'Logowanie…' : 'Zaloguj'} disabled={busy || !email || !password} onPress={submit} />
      {/* tap counter for spike Q4 (XCUITest tap latency + delivery) */}
      <Button title={`Licznik ${taps}`} onPress={() => setTaps(n => n + 1)} />
      <Button title="Wstecz" onPress={onBack} />
    </View>
  );
}

function LoggedIn({ name, onLogout }: { name: string; onLogout: () => void }) {
  const slide = useRef(new Animated.Value(400)).current;
  const [toast, setToast] = useState(true);
  const [moved, setMoved] = useState(false);
  useEffect(() => {
    Animated.timing(slide, { toValue: 0, duration: 350, useNativeDriver: true }).start();
    const t = setTimeout(() => setToast(false), 300 + Math.random() * 400);
    return () => clearTimeout(t);
  }, [slide]);
  return (
    <View style={styles.screen}>
      <Animated.View style={{ transform: [{ translateX: slide }] }}>
        <Text style={styles.title}>Cześć, {name}</Text>
        <Button title="Wyloguj" onPress={onLogout} />
      </Animated.View>
      {toast && (
        <View style={styles.toast}>
          <Text style={styles.toastText}>Zalogowano</Text>
        </View>
      )}
      {/* layout lab for spike Q5 */}
      <View style={{ marginTop: moved ? 120 : 20 }}>
        <Button title="Przesuń" onPress={() => setMoved(m => !m)} />
      </View>
    </View>
  );
}

function LoginFlow({ onBack }: { onBack: () => void }) {
  const [user, setUser] = useState<string | null>(null);
  return user ? <LoggedIn name={user} onLogout={() => setUser(null)} /> : <Login onLogin={setUser} onBack={onBack} />;
}

function Counter({ onBack }: { onBack: () => void }) {
  const [n, setN] = useState(0);
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Licznik: {n}</Text>
      <Button title="Dodaj" onPress={() => setN(x => x + 1)} />
      <Button title="Wstecz" onPress={onBack} />
    </View>
  );
}

const ITEMS = Array.from({ length: 100 }, (_, i) => `Element ${i + 1}`);

function List({ onBack }: { onBack: () => void }) {
  const [picked, setPicked] = useState('nic');
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Wybrano: {picked}</Text>
      <Button title="Wstecz" onPress={onBack} />
      <FlatList
        testID="list"
        data={ITEMS}
        keyExtractor={x => x}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" onPress={() => setPicked(item)} style={styles.row}>
            <Text style={styles.rowText}>{item}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

// Auto-scroll lab: a horizontal list, a long virtualized vertical list, and a horizontal shelf nested in it (row 40)
const TILES = Array.from({ length: 30 }, (_, i) => `Kafel ${i + 1}`);
const ROWS = Array.from({ length: 200 }, (_, i) => `Wiersz ${i + 1}`);
const SHELF = Array.from({ length: 20 }, (_, i) => `Półka ${i + 1}`);

function Scrolling({ onBack }: { onBack: () => void }) {
  const [picked, setPicked] = useState('nic');
  const pick = (id: string, item: string) => (
    <Pressable testID={id} accessibilityRole="button" onPress={() => setPicked(item)} style={styles.tile}>
      <Text style={styles.rowText}>{item}</Text>
    </Pressable>
  );
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Wybrano: {picked}</Text>
      <Button title="Wstecz" onPress={onBack} />
      <FlatList testID="tiles" horizontal data={TILES} keyExtractor={x => x} renderItem={({ item, index }) => pick(`tile-${index + 1}`, item)} style={styles.shelf} />
      <FlatList
        testID="rows"
        data={ROWS}
        keyExtractor={x => x}
        renderItem={({ item, index }) =>
          index === 39 ? (
            <FlatList testID="shelf" horizontal data={SHELF} keyExtractor={x => x} renderItem={s => pick(`shelf-${s.index + 1}`, s.item)} style={styles.shelf} />
          ) : (
            <Pressable testID={`row-${index + 1}`} accessibilityRole="button" onPress={() => setPicked(item)} style={styles.row}>
              <Text style={styles.rowText}>{item}</Text>
            </Pressable>
          )
        }
      />
    </View>
  );
}

function Details({ onBack }: { onBack: () => void }) {
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Szczegóły produktu</Text>
      <Text style={styles.body}>Cena: 49 zł</Text>
      <Button title="Wstecz" onPress={onBack} />
    </View>
  );
}

function Loading({ onBack }: { onBack: () => void }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done'>('idle');
  const load = () => {
    setState('loading');
    // fake network: 1000-2000 ms
    setTimeout(() => setState('done'), 1000 + Math.random() * 1000);
  };
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Dane</Text>
      <Button title="Załaduj" disabled={state === 'loading'} onPress={load} />
      {state === 'loading' && <ActivityIndicator testID="spinner" accessibilityLabel="Ładowanie danych" size="large" />}
      {state === 'done' && (
        <View>
          <Text style={styles.body}>Załadowano 5 wyników</Text>
          {[1, 2, 3, 4, 5].map(i => (
            <Text key={i} style={styles.body}>Wynik {i}</Text>
          ))}
        </View>
      )}
      <Button title="Wstecz" onPress={onBack} />
    </View>
  );
}

function Form({ onBack }: { onBack: () => void }) {
  const [name, setName] = useState('Jan');
  const [notify, setNotify] = useState(false);
  const [saved, setSaved] = useState(false);
  const [keys, setKeys] = useState(0);
  const [sheet, setSheet] = useState(false);
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Formularz</Text>
      <TextInput testID="name-input" accessibilityLabel="Imię" style={styles.input} value={name} onChangeText={setName} />
      {/* uncontrolled: what is typed lives natively; onKeyPress counts the keys app.keyboard.type sends */}
      <TextInput testID="note-input" placeholder="Notatka" style={styles.input} onKeyPress={() => setKeys(k => k + 1)} />
      <Text style={styles.body}>Klawisze: {keys}</Text>
      <View style={styles.switchRow}>
        <Text style={styles.body}>Powiadomienia</Text>
        <Switch testID="notify-switch" accessibilityLabel="Powiadomienia" value={notify} onValueChange={setNotify} />
      </View>
      <Button title="Zapisz" onPress={() => setSaved(true)} />
      <Button title="Wstecz" onPress={onBack} />
      <Button title="Arkusz" onPress={() => setSheet(true)} />
      <Modal visible={saved} transparent animationType="fade" onRequestClose={() => setSaved(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modal}>
            <Text style={styles.body}>
              Zapisano: {name}, powiadomienia: {notify ? 'tak' : 'nie'}
            </Text>
            <Button title="Zamknij" onPress={() => setSaved(false)} />
          </View>
        </View>
      </Modal>
      {/* iOS page sheet: its React root starts below the top of the screen (Android: full screen) */}
      <Modal visible={sheet} presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setSheet(false)}>
        <View style={styles.screen}>
          <Button title="Zamknij arkusz" onPress={() => setSheet(false)} />
        </View>
      </Modal>
    </View>
  );
}

// Gesture Handler lab for the iOS tap spike: taps/pans must reach RNGH's native recognizers.
function Gestures({ onBack }: { onBack: () => void }) {
  const [taps, setTaps] = useState(0);
  const [pan, setPan] = useState(0);
  const tap = useTapGesture({ runOnJS: true, onActivate: () => setTaps(n => n + 1) });
  const drag = usePanGesture({ runOnJS: true, onDeactivate: e => setPan(Math.round(e.translationX)) });
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Gesty</Text>
      <GestureDetector gesture={tap}>
        <View accessible accessibilityRole="button" accessibilityLabel="GH tap" style={styles.ghBox}>
          <Text style={styles.buttonText}>GH tap: {taps}</Text>
        </View>
      </GestureDetector>
      <GestureDetector gesture={drag}>
        <View accessible accessibilityLabel="GH pan" style={[styles.ghBox, styles.ghPan]}>
          <Text style={styles.buttonText}>GH pan: {pan}</Text>
        </View>
      </GestureDetector>
      <Button title="Wstecz" onPress={onBack} />
    </View>
  );
}

// System windows lab: what the app's own screenshot and snapshot don't have. A native surface (Android SurfaceView, iOS
// Metal layer: example/android LabPackage.kt, example/ios Lab.m), a system permission prompt, a native Alert, a Modal.
const LabSurface = requireNativeComponent<{ testID?: string; style?: object }>('LabSurface');
function Windows({ onBack }: { onBack: () => void }) {
  const [modal, setModal] = useState(false);
  const [answer, setAnswer] = useState('brak');
  const ask = async () => {
    if (Platform.OS === 'ios') return NativeModules.Lab.askPermission();
    setAnswer(await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS'));
  };
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Okna</Text>
      {/* first: above a dialog in the middle of the screen, where a tap under the dialog goes */}
      <Button title="Okno Modal" onPress={() => setModal(true)} />
      <LabSurface testID="surface" style={styles.surface} />
      <Button title="Uprawnienie" onPress={ask} />
      <Text style={styles.body}>Odpowiedź: {answer}</Text>
      {/* cancelable: Android closes it on a touch outside its box */}
      <Button title="Komunikat" onPress={() => Alert.alert('Komunikat', 'Natywny', [{ text: 'OK' }], { cancelable: true })} />
      {Platform.OS === 'android' && (
        <Button
          title="Komunikat i aktywność"
          onPress={() => {
            // the Alert stays with this activity, under the other one, which hides both
            Alert.alert('Komunikat', 'Natywny', [{ text: 'OK' }]);
            setTimeout(() => Linking.openURL('probespike-lab://lab'), 500);
          }}
        />
      )}
      <Button title="Wstecz" onPress={onBack} />
      <Modal visible={modal} animationType="none" onRequestClose={() => setModal(false)}>
        <View style={styles.screen}>
          <Button title="Zamknij okno" onPress={() => setModal(false)} />
        </View>
      </Modal>
    </View>
  );
}

// Alert lab for app.back(): back runs the cancel-style button, an alert without one stays
function Alerts({ onBack }: { onBack: () => void }) {
  const [log, setLog] = useState<string[]>([]);
  const add = (s: string) => () => setLog(l => [...l, s]);
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Alerty</Text>
      <Button
        title="Usuń"
        onPress={() =>
          Alert.alert('Usunąć?', undefined, [
            { text: 'Anuluj', style: 'cancel', onPress: add('anulowano') },
            { text: 'Usuń', style: 'destructive', onPress: add('usunięto') },
          ])
        }
      />
      <Button title="Info" onPress={() => Alert.alert('Gotowe', undefined, [{ text: 'OK', onPress: add('ok') }])} />
      <Button title="Bez przycisków" onPress={() => Alert.alert('Uwaga')} />
      <Text style={styles.body}>Log: {log.join(', ') || 'pusty'}</Text>
      <Button title="Wstecz" onPress={onBack} />
    </View>
  );
}

// idle() lab: a loading overlay with a spinner that is hidden but stays mounted, faded to opacity 0 (native driver) or
// moved off screen. Its spinner keeps looping natively; idle() must not wait for it.
function Overlay({ onBack }: { onBack: () => void }) {
  const [mode, setMode] = useState<'fade' | 'away' | null>(null);
  const [hidden, setHidden] = useState(false);
  const opacity = useRef(new Animated.Value(1)).current;
  const show = (m: 'fade' | 'away') => {
    setHidden(false);
    opacity.setValue(1);
    setMode(m);
    setTimeout(() => {
      if (m === 'away') return setHidden(true);
      Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }).start(() => setHidden(true));
    }, 300);
  };
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Nakładka: {mode == null ? 'brak' : hidden ? 'ukryta' : 'widoczna'}</Text>
      <Button title="Zanikanie" onPress={() => show('fade')} />
      <Button title="Poza ekran" onPress={() => show('away')} />
      <Button title="Wstecz" onPress={onBack} />
      {mode && (
        <Animated.View
          testID="overlay"
          pointerEvents="none"
          style={[styles.overlay, { opacity }, mode === 'away' && hidden && { left: -2000, right: 2000 }]}>
          <ActivityIndicator testID="overlay-spinner" size="large" />
        </Animated.View>
      )}
    </View>
  );
}

// idle() lab: work that lands a while after the tap (a timer, a WebSocket reply, a native animation, an image from the
// network) and work that never ends (an interval, timers that re-arm themselves, a socket the server pings, a loop).
// The server is the e2e test's (e2e/idle.mantis.js), on the host; Android reaches it through adb reverse.
const LAB = 'localhost:9124';
function Later({ onBack }: { onBack: () => void }) {
  const [state, setState] = useState('nic');
  const [image, setImage] = useState<string | null>(null);
  const x = useRef(new Animated.Value(0)).current;
  const stops = useRef<(() => void)[]>([]);
  useEffect(() => () => stops.current.forEach(stop => stop()), []);
  const background = () => {
    const interval = setInterval(() => {}, 1000);
    let timeout = setTimeout(function tick() {
      timeout = setTimeout(tick, 300);
    }, 300);
    let on = true;
    (async () => {
      while (on) await new Promise<void>(r => setTimeout(r, 700));
    })();
    stops.current.push(() => {
      clearInterval(interval);
      clearTimeout(timeout);
      on = false;
    });
    setState('w tle');
  };
  const socket = () => {
    const ws = new WebSocket(`ws://${LAB}/`);
    ws.onopen = () => ws.send('hej');
    // the server pings every 200 ms after its reply: a pong answers it, it is not a request
    ws.onmessage = e => (e.data === 'ping' ? ws.send('pong') : setState(`WS ${e.data}`));
    stops.current.push(() => ws.close());
  };
  const move = (delay: number) => {
    x.setValue(0);
    Animated.timing(x, { toValue: 200, duration: 800, delay, useNativeDriver: true }).start(() => setState('przesunięte'));
  };
  const loop = () => Animated.loop(Animated.timing(x, { toValue: 200, duration: 400, useNativeDriver: true })).start();
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Stan: {state}</Text>
      <Button title="Za chwilę" onPress={() => setTimeout(() => setState('po czasie'), 800)} />
      <Button title="W tle" onPress={background} />
      <Button title="WebSocket" onPress={socket} />
      <View style={styles.switchRow}>
        <Button title="Ruch" onPress={() => move(0)} />
        <Button title="Ruch później" onPress={() => move(600)} />
        <Button title="Pętla" onPress={loop} />
      </View>
      <Button title="Obrazek" onPress={() => setImage(`http://${LAB}/image.png?${Date.now()}`)} />
      <Button title="Wstecz" onPress={onBack} />
      <Animated.View testID="box" style={[styles.box, { transform: [{ translateX: x }] }]} />
      {image && <Image testID="image" source={{ uri: image }} onLoad={() => setState('obrazek')} style={styles.box} />}
    </View>
  );
}

// e2e/stuck.mantis.js: a thread that runs nothing for 9 s (main: through the app's own URL, see MainActivity and
// SceneDelegate), a crash (Android: the main thread, behind the system's crash dialog)
function Stuck({ onBack }: { onBack: () => void }) {
  const busy = () => {
    for (const end = Date.now() + 9000; Date.now() < end; );
  };
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Zawieszenie</Text>
      <Button title="Wątek główny" onPress={() => Linking.openURL('probespike://hang?ms=9000')} />
      {/* later: the tap's own RPCs run first */}
      <Button title="Wątek JS" onPress={() => setTimeout(busy, 300)} />
      <Button title="Awaria" onPress={() => Linking.openURL('probespike://crash')} />
      <Button title="Wstecz" onPress={onBack} />
    </View>
  );
}

const SCREENS = {
  Logowanie: LoginFlow,
  Licznik: Counter,
  Lista: List,
  Szczegóły: Details,
  Ładowanie: Loading,
  Formularz: Form,
  Gesty: Gestures,
  Nakładka: Overlay,
  Przewijanie: Scrolling,
  Okna: Windows,
  Alerty: Alerts,
  Później: Later,
  Zawieszenie: Stuck,
};

export default function App() {
  const [screen, setScreen] = useState<keyof typeof SCREENS | null>(null);
  useEffect(() => {
    // Android hardware back returns to the menu
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!screen) return false;
      setScreen(null);
      return true;
    });
    return () => sub.remove();
  }, [screen]);
  const Screen = screen && SCREENS[screen];
  return (
    <GestureHandlerRootView style={styles.root}>
      {Screen ? (
        <Screen onBack={() => setScreen(null)} />
      ) : (
        <ScrollView style={styles.root} contentContainerStyle={styles.menu}>
          <Text style={styles.title}>Menu</Text>
          {(Object.keys(SCREENS) as (keyof typeof SCREENS)[]).map(s => (
            <Button key={s} title={s} onPress={() => setScreen(s)} />
          ))}
        </ScrollView>
      )}
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  screen: { flex: 1, padding: 24, paddingTop: 80, backgroundColor: '#fff' },
  menu: { flexGrow: 1, padding: 24, paddingTop: 80, backgroundColor: '#fff' },
  title: { fontSize: 24, fontWeight: '600', marginBottom: 16, color: '#111' },
  body: { fontSize: 16, marginBottom: 8, color: '#111' },
  input: { borderWidth: 1, borderColor: '#999', borderRadius: 6, padding: 10, marginBottom: 12, color: '#111' },
  button: { backgroundColor: '#2563eb', padding: 14, borderRadius: 6, alignItems: 'center', marginBottom: 12 },
  buttonDisabled: { backgroundColor: '#9ca3af' },
  buttonText: { color: '#fff', fontWeight: '600' },
  toast: { position: 'absolute', top: 120, left: 0, right: 0, height: 120, backgroundColor: '#111d', justifyContent: 'center', alignItems: 'center' },
  toastText: { color: '#fff' },
  row: { paddingVertical: 14, borderBottomWidth: 1, borderColor: '#eee' },
  rowText: { fontSize: 16, color: '#111' },
  tile: { width: 110, paddingVertical: 14, marginRight: 8, alignItems: 'center', backgroundColor: '#e5e7eb', borderRadius: 6 },
  shelf: { flexGrow: 0, marginBottom: 12 },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  modalBackdrop: { flex: 1, backgroundColor: '#0006', justifyContent: 'center', padding: 24 },
  modal: { backgroundColor: '#fff', borderRadius: 8, padding: 24 },
  ghBox: { height: 120, backgroundColor: '#16a34a', borderRadius: 8, justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  ghPan: { backgroundColor: '#9333ea' },
  surface: { height: 100, marginBottom: 12 },
  box: { width: 40, height: 40, backgroundColor: '#f59e0b' },
  overlay: { ...StyleSheet.absoluteFill, backgroundColor: '#0008', justifyContent: 'center', alignItems: 'center' },
});
