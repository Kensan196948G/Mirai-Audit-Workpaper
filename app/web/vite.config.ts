import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      // 通常UI（index.html）と本番用UI（index.production.html）を両方ビルドする
      input: {
        main: fileURLToPath(new URL("index.html", import.meta.url)),
        production: fileURLToPath(
          new URL("index.production.html", import.meta.url),
        ),
      },
    },
  },
  server: {
    port: 5174,
  },
});
