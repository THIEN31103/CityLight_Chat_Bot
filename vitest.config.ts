// Unit tests only: apps/e2e holds Playwright specs (`npm run e2e:browser`), which vitest cannot run.
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({ test: { exclude: [...configDefaults.exclude, 'apps/e2e/**'] } });
