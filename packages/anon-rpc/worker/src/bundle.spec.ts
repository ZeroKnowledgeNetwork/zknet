// The bundle's bytes are its identity (Anon-RPC SPEC v0.3.2 §4): two builds must agree, and
// nothing machine-specific may leak into them. Nor may the source's layout: a reformat is not a
// new worker.

import { readFile } from "node:fs/promises";
import { format } from "oxfmt";
import type { Plugin } from "esbuild";

type Build = { bundle(options?: { plugins?: Plugin[] }): Promise<Uint8Array> };

const load = async () => (await import(new URL("../build.mjs", import.meta.url).href)) as Build;

/** Rewrites every first-party .ts source as it is loaded; leaves node_modules alone. */
const rewrite = (name: string, edit: (path: string, text: string) => Promise<string>): Plugin => ({
  name,
  setup(build) {
    build.onLoad({ filter: /\.ts$/ }, async ({ path }) =>
      path.includes("/node_modules/")
        ? undefined
        : { contents: await edit(path, await readFile(path, "utf8")), loader: "ts" },
    );
  },
});

// As far from the repository's own style as oxfmt goes.
const restyle = rewrite("restyle", async (path, text) => {
  const { code, errors } = await format(path, text, {
    useTabs: true,
    tabWidth: 8,
    printWidth: 40,
    singleQuote: true,
    semi: false,
    quoteProps: "consistent",
    trailingComma: "none",
    arrowParens: "avoid",
    bracketSpacing: false,
  });
  if (errors.length > 0) throw new Error(`${path}: ${errors[0].message}`);
  return `// a comment that is not code\n${code}`;
});

describe("worker bundle", () => {
  it("is byte-stable across builds and carries no host paths", async () => {
    const { bundle } = await load();
    const [a, b] = [await bundle(), await bundle()];
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const text = new TextDecoder().decode(a);
    expect(text).not.toContain(process.cwd());
    expect(text).not.toMatch(/\/home\/|\/Users\/|[A-Z]:\\\\/);
    expect(text).not.toContain("stub-walletshield");
  }, 30_000);

  it("does not change when the source is reformatted", async () => {
    const { bundle } = await load();
    const plain = await bundle();
    const restyled = await bundle({ plugins: [restyle] });
    expect(Buffer.from(restyled).equals(Buffer.from(plain))).toBe(true);
  }, 30_000);

  it("changes when the code does", async () => {
    const { bundle } = await load();
    const plain = await bundle();
    let edits = 0;
    const edited = await bundle({
      plugins: [
        rewrite("edit", async (path, text) => {
          if (!path.endsWith("/limits.ts")) return text;
          edits += 1;
          return text.replace("128 * 1024", "129 * 1024");
        }),
      ],
    });
    expect(edits).toBe(1);
    expect(Buffer.from(edited).equals(Buffer.from(plain))).toBe(false);
  }, 30_000);
});
