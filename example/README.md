# Mantis example app

The test app from the rn-e2e spike (login, counter, list, details, loading, form, gestures), wired to the package in
the repo root (`"@codelionapps/mantis": "file:.."`). `e2e/app.test.js` holds the spike's scenarios as plain Detox tests.

```sh
npm install && (cd ios && bundle exec pod install)
npm run e2e:build:android && npm run e2e:android   # emulator: ANDROID_SERIAL, default emulator-5554
npm run e2e:build:ios && npm run e2e:ios           # simulator: SIM_TYPE, default "iPhone 17"
npx detox test -c android.release                  # the same tests on plain Detox
```

The build commands set `MANTIS_E2E=1`. Without it the app contains no agent: `../scripts/check-release.sh <apk|app>`.

Two settings exist only because the package is linked from outside `node_modules`; apps that install it don't need
them:

- `metro.config.js`: `watchFolders` + `disableHierarchicalLookup`, so the agent's `react-native` imports resolve
  to this app's copy (a second copy in the bundle would be a second renderer, and taps stop working).
- `e2e/jest.config.js`: `transformIgnorePatterns` for `../src`.

Android release builds don't track the linked package's files: after changing `../src/agent`, delete
`android/app/build/generated/assets/react` so the JS bundle is rebuilt.

The benchmark against Detox and Maestro (scripts and raw results) stays with the spike, in the `rn-e2e` repo
(`ProbeSpike/bench`); its write-ups are in `../docs/spike`.
