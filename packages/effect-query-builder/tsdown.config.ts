import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "./src/index.ts",
    "./src/sqlite.ts",
    "./src/pg.ts",
    "./src/mysql.ts",
    "./src/ddl.ts",
  ],
  dts: true,
  format: "esm",
  outDir: "dist",
  platform: "neutral",
  copy: { from: "../../LICENSE" },
});
