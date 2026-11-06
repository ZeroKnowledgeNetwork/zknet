import { detectPlatform, fromUA, type NavigatorLike, type Platform } from "./detect.ts";

const UA = {
  linuxChrome:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  winChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
  cros: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  linuxArmFirefox: "Mozilla/5.0 (X11; Linux aarch64; rv:144.0) Gecko/20100101 Firefox/144.0",
  winFirefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0",
};

// Chromium: the UA string plus Client Hints
const chromium = (ua: string, platform: string, architecture: string): NavigatorLike => ({
  userAgent: ua,
  userAgentData: { platform, getHighEntropyValues: async () => ({ architecture, bitness: "64" }) },
});

describe("detectPlatform with Client Hints (Chromium)", () => {
  it.each<[string, NavigatorLike, Platform]>([
    ["Linux x86", chromium(UA.linuxChrome, "Linux", "x86"), { os: "linux", arch: "x86_64" }],
    [
      "macOS on Apple silicon",
      chromium(UA.macChrome, "macOS", "arm"),
      { os: "macos", arch: "arm64" },
    ],
    ["macOS on Intel", chromium(UA.macChrome, "macOS", "x86"), { os: "macos", arch: "x86_64" }],
    ["Windows on Arm", chromium(UA.winChrome, "Windows", "arm"), { os: "windows", arch: "arm64" }],
    ["Android", chromium(UA.androidChrome, "Android", "arm"), { os: "android", arch: "arm64" }],
    ["ChromeOS", chromium(UA.cros, "Chrome OS", "x86"), { os: "chromeos", arch: "x86_64" }],
  ])("%s", async (_, nav, want) => {
    expect(await detectPlatform(nav)).toEqual(want);
  });

  it("falls back to the UA when the hints are refused", async () => {
    const nav: NavigatorLike = {
      userAgent: UA.winChrome,
      userAgentData: {
        platform: "Windows",
        getHighEntropyValues: () => Promise.reject(new Error("denied")),
      },
    };
    expect(await detectPlatform(nav)).toEqual({ os: "windows", arch: "x86_64" });
  });
});

describe("detectPlatform from the UA string only (Firefox, Safari)", () => {
  it.each<[string, string, number, Platform]>([
    // Safari's UA says Intel on Apple silicon too: the arch is unknown, not x86_64
    ["macOS Safari", UA.macSafari, 0, { os: "macos", arch: "unknown" }],
    ["iPhone Safari", UA.iphoneSafari, 5, { os: "ios", arch: "unknown" }],
    ["iPadOS Safari (a desktop UA with touch)", UA.macSafari, 5, { os: "ios", arch: "unknown" }],
    ["Linux aarch64 Firefox", UA.linuxArmFirefox, 0, { os: "linux", arch: "arm64" }],
    ["Windows Firefox", UA.winFirefox, 0, { os: "windows", arch: "x86_64" }],
  ])("%s", async (_, userAgent, maxTouchPoints, want) => {
    expect(await detectPlatform({ userAgent, maxTouchPoints })).toEqual(want);
  });

  it("knows nothing of an unrecognised UA", () => {
    expect(fromUA("curl/8.0")).toEqual({ os: "unknown", arch: "unknown" });
  });
});
