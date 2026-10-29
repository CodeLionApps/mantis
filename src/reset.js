// Jest setupFilesAfterEnv for `detox test --reuse`: Detox then no longer reinstalls the app before each test file,
// so wipe its data at the start of each file instead (fresh-install state for files that launch without `delete`).
const { clearAppData } = require("./device");

beforeAll(() => clearAppData());
