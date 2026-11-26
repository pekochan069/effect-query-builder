await Bun.build({
  entrypoints: [
    "./src/index.ts",
    "./src/sqlite.ts",
    "./src/pg.ts",
    "./src/mysql.ts",
    "./src/ddl.ts",
  ],
  outdir: "./dist",
  dts: true,
});
