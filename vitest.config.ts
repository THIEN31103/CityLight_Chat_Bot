// Unit tests of apps/jarvis and packages/shared. `.tmp/` holds local scratch scripts, never tests.
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({ test: { exclude: [...configDefaults.exclude, '.tmp/**'] } });
