import { defineConfig } from "vitest/config";

// Tests spawn real shells; on Windows each taskkill takes about a second.
export default defineConfig({
	test: {
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
