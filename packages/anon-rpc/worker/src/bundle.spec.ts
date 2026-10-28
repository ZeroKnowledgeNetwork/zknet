// The bundle's bytes are its identity (Anon-RPC SPEC v0.3.2 §4): two builds must agree, and
// nothing machine-specific may leak into them.

type Build = { bundle(): Promise<Uint8Array> };

describe("worker bundle", () => {
  it("is byte-stable across builds and carries no host paths", async () => {
    const { bundle } = (await import(new URL("../build.mjs", import.meta.url).href)) as Build;
    const [a, b] = [await bundle(), await bundle()];
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const text = new TextDecoder().decode(a);
    expect(text).not.toContain(process.cwd());
    expect(text).not.toMatch(/\/home\/|\/Users\/|[A-Z]:\\\\/);
    expect(text).not.toContain("stub-walletshield");
  }, 30_000);
});
