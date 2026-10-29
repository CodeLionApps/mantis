// The spike's scenarios as plain Detox tests: `detox test` runs them on Detox, `E2E_RUNNER=mantis detox test` on Mantis.
const tests = {
  login: async () => {
    await element(by.text('Logowanie')).tap();
    await element(by.id('email')).typeText('ala@example.com');
    await element(by.id('password')).typeText('sekret');
    await element(by.text('Zaloguj')).tap();
    await expect(element(by.text('Cześć, Ala'))).toBeVisible();
    await element(by.text('Wyloguj')).tap();
    await expect(element(by.text('Logowanie'))).toBeVisible();
  },
  counter: async () => {
    await element(by.text('Licznik')).tap();
    for (let i = 0; i < 5; i++) await element(by.text('Dodaj')).tap();
    await expect(element(by.text('Licznik: 5'))).toBeVisible();
  },
  list: async () => {
    await element(by.text('Lista')).tap();
    await waitFor(element(by.text('Element 60'))).toBeVisible().whileElement(by.id('list')).scroll(400, 'down');
    await element(by.text('Element 60')).tap();
    await expect(element(by.text('Wybrano: Element 60'))).toBeVisible();
  },
  details: async () => {
    await element(by.text('Szczegóły')).tap();
    await expect(element(by.text('Szczegóły produktu'))).toBeVisible();
    await expect(element(by.text('Cena: 49 zł'))).toBeVisible();
    await element(by.text('Wstecz')).tap();
    await expect(element(by.text('Menu'))).toBeVisible();
    await expect(element(by.text('Szczegóły produktu'))).not.toBeVisible();
  },
  loading: async () => {
    await element(by.text('Ładowanie')).tap();
    await element(by.text('Załaduj')).tap();
    await waitFor(element(by.text('Załadowano 5 wyników'))).toBeVisible().withTimeout(5000);
    await expect(element(by.text('Wynik 5'))).toBeVisible();
    await expect(element(by.id('spinner'))).not.toBeVisible();
  },
  form: async () => {
    await element(by.text('Formularz')).tap();
    await element(by.id('name-input')).clearText();
    await element(by.id('name-input')).typeText('Ala');
    await element(by.id('notify-switch')).tap();
    await element(by.text('Zapisz')).tap();
    await expect(element(by.text('Zapisano: Ala, powiadomienia: tak'))).toBeVisible();
    await element(by.text('Zamknij')).tap();
    await expect(element(by.text('Zapisano: Ala, powiadomienia: tak'))).not.toBeVisible();
  },
};

beforeEach(async () => {
  await device.launchApp({ newInstance: true });
});

for (const [name, fn] of Object.entries(tests)) it(name, fn);
