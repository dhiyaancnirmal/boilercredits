import { defineConfig, loadEnv } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.BC_API ?? "http://127.0.0.1:8787";
  const isRemote = /^https?:\/\//.test(apiTarget) && !apiTarget.includes("127.0.0.1") && !apiTarget.includes("localhost");
  return {
    plugins: [preact({ devToolsEnabled: false })],
    root: "frontend",
    build: {
      outDir: "../dist/public",
      emptyOutDir: true,
    },
    server: {
      port: 5174,
      strictPort: true,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: isRemote,
          secure: isRemote,
        },
      },
    },
  };
});
