// Types of @codelionapps/mantis/metro (README: Setup).
/** With MANTIS_E2E=1 at bundle time, the config with the JS agent added; else the config unchanged. */
export function withMantis<T extends object>(config: T): T;
