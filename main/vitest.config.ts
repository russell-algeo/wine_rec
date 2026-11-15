import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests never talk to Vivino; don't wait between mocked requests.
    env: { VIVINO_DIRECT_DELAY_MS: "0" },
  },
});
