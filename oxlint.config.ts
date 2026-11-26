import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import { selectJsPlugins } from "ultracite/oxlint/js-plugins";
import landmines from "ultracite/oxlint/landmines";
import shadcn from "ultracite/oxlint/shadcn";

const jsPlugins = selectJsPlugins(["tsdoc"]);

export default defineConfig({
  env: core.env,
  extends: [core, jsPlugins, shadcn, landmines, antiSlop],
  ignorePatterns: core.ignorePatterns,
  jsPlugins: [
    ...jsPlugins.jsPlugins,
    ...shadcn.jsPlugins,
    ...landmines.jsPlugins,
  ],
  options: { typeAware: true },
  overrides: [
    {
      files: ["packages/effect-query-builder/tests/**/*.test.ts"],
      rules: {
        "landmines-structure/colocated-tests": "off",
        "landmines-structure/test-file-names": "off",
      },
    },
    {
      files: [
        "packages/effect-query-builder/src/column-names.ts",
        "packages/effect-query-builder/src/kernel/invariants.ts",
      ],
      rules: { "landmines-style/no-comments": "off" },
    },
  ],
});
