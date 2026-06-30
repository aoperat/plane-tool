import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  clearScreen: false,
  server: { port: 5174, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        quickadd: resolve(__dirname, "src/quickadd/index.html"),
        sidebar: resolve(__dirname, "src/sidebar/index.html"),
        settings: resolve(__dirname, "src/settings/index.html"),
      },
    },
  },
});
