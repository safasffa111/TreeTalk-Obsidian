import esbuild from "esbuild";

const production = process.argv[2] === "production";

const workerSourcePlugin = {
  name: "relationship-graph-worker-source",
  setup(build) {
    build.onResolve(
      { filter: /^virtual:relationship-graph-worker-source$/ },
      () => ({
        path: "relationship-graph-worker-source",
        namespace: "relationship-graph-worker"
      })
    );
    build.onLoad(
      { filter: /.*/, namespace: "relationship-graph-worker" },
      async () => {
        const worker = await esbuild.build({
          entryPoints: ["src/relationship-graph/worker-entry.ts"],
          bundle: true,
          format: "iife",
          platform: "browser",
          target: "es2022",
          minify: production,
          write: false,
          metafile: true
        });
        const source = worker.outputFiles[0]?.text;
        if (source === undefined) {
          throw new Error("Relationship graph Worker build produced no output");
        }
        return {
          contents: `export default ${JSON.stringify(source)};`,
          loader: "js",
          watchFiles: Object.keys(worker.metafile.inputs)
        };
      }
    );
  }
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr"
  ],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  minify: production,
  plugins: [workerSourcePlugin],
  outfile: "main.js"
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
