import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { isolatedHtml } from "./isolated-html";

export default defineConfig(({ mode }) => ({
  plugins: [react(), {
    name: "isolated-html",
    transformIndexHtml: (html: string) => isolatedHtml(html,
      (process.env.VITE_ISOLATED ?? loadEnv(mode, process.cwd(), "VITE_").VITE_ISOLATED) === "true"),
  }],
  // The shared contracts workspace emits CommonJS and now supplies runtime
  // evidence predicates as well as types. Include its linked output explicitly.
  optimizeDeps: { include: ["@wine-rec/contracts"] },
  build: { commonjsOptions: { include: [/node_modules/, /packages\/contracts\/dist/] } },
  server: {
    port: 5173,
  },
}));
