import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./tests/obsidian-runtime-mock.ts", import.meta.url)),
      "virtual:relationship-graph-worker-source": fileURLToPath(
        new URL("./tests/virtual-worker-source.ts", import.meta.url)
      )
    }
  },
  test: {
    environment: "node",
    exclude: [
      "regression/**/*.node.test.mjs",
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*"
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"]
    }
  }
});
