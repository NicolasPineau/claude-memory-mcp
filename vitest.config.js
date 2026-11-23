import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: { bindings: { MEMORY_SECRET: "test-secret-0123456789abcdef", CF_ACCOUNT_ID: "compte-test", CF_API_TOKEN: "jeton-test" } },
    }),
  ],
});
