// Spike app: a menu of small screens for the iOS tap spike and the Mantis/Detox/Maestro benchmark.
// Login is built to be hostile to naive E2E drivers: async "network", disabled-until-valid button,
// native-driver enter animation, a toast that briefly covers the next button.
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
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
      <TextInput testID="email" accessibilityLabel="E-mail" style={styles.input} value={email} onChangeText={setEmail} autoCapitalize="none" />
      <TextInput testID="password" accessibilityLabel="Hasło" style={styles.input} value={password} onChangeText={setPassword} secureTextEntry />
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
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Formularz</Text>
      <TextInput testID="name-input" accessibilityLabel="Imię" style={styles.input} value={name} onChangeText={setName} />
      <View style={styles.switchRow}>
        <Text style={styles.body}>Powiadomienia</Text>
        <Switch testID="notify-switch" accessibilityLabel="Powiadomienia" value={notify} onValueChange={setNotify} />
      </View>
      <Button title="Zapisz" onPress={() => setSaved(true)} />
      <Button title="Wstecz" onPress={onBack} />
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

const SCREENS = {
  Logowanie: LoginFlow,
  Licznik: Counter,
  Lista: List,
  Szczegóły: Details,
  Ładowanie: Loading,
  Formularz: Form,
  Gesty: Gestures,
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
        <View style={styles.screen}>
          <Text style={styles.title}>Menu</Text>
          {(Object.keys(SCREENS) as (keyof typeof SCREENS)[]).map(s => (
            <Button key={s} title={s} onPress={() => setScreen(s)} />
          ))}
        </View>
      )}
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  screen: { flex: 1, padding: 24, paddingTop: 80, backgroundColor: '#fff' },
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
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  modalBackdrop: { flex: 1, backgroundColor: '#0006', justifyContent: 'center', padding: 24 },
  modal: { backgroundColor: '#fff', borderRadius: 8, padding: 24 },
  ghBox: { height: 120, backgroundColor: '#16a34a', borderRadius: 8, justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  ghPan: { backgroundColor: '#9333ea' },
});
