// The visitor's platform, read locally: User-Agent Client Hints where the
// browser has them (Chromium), the User-Agent string everywhere else. Nothing
// leaves the browser.

export type OS = "windows" | "macos" | "linux" | "android" | "ios" | "chromeos" | "unknown";
export type Arch = "x86_64" | "arm64" | "unknown";
export type Platform = { os: OS; arch: Arch };

type UAData = {
  platform: string;
  getHighEntropyValues(hints: string[]): Promise<{ architecture?: string; bitness?: string }>;
};
// the part of Navigator this reads
export type NavigatorLike = { userAgent: string; maxTouchPoints?: number; userAgentData?: UAData };

export function fromUA(ua: string, maxTouchPoints = 0): Platform {
  // order matters: Android UAs say Linux, iPadOS UAs may say Macintosh
  const os: OS = /Android/i.test(ua)
    ? "android"
    : /iPhone|iPad|iPod/i.test(ua)
      ? "ios"
      : /CrOS/.test(ua)
        ? "chromeos"
        : /Windows/.test(ua)
          ? "windows"
          : /Macintosh|Mac OS X/.test(ua)
            ? maxTouchPoints > 1
              ? "ios" // iPadOS presents a desktop Safari UA
              : "macos"
            : /Linux|X11/.test(ua)
              ? "linux"
              : "unknown";
  // A frozen UA (Chrome's UA reduction) always reports x86_64 on Linux and
  // Intel on macOS; Firefox still reports aarch64. Apple silicon cannot be told
  // from Safari's UA (moot while the macOS build is universal), so on macOS
  // the UA's "Intel" says nothing.
  const arch: Arch = /aarch64|arm64/i.test(ua)
    ? "arm64"
    : os !== "macos" && /x86_64|x64|Win64|WOW64|amd64/i.test(ua)
      ? "x86_64"
      : "unknown";
  return { os, arch };
}

const OS_BY_HINT: Record<string, OS> = {
  Windows: "windows",
  macOS: "macos",
  Linux: "linux",
  Android: "android",
  "Chrome OS": "chromeos",
  ChromeOS: "chromeos",
  iOS: "ios",
};

export async function detectPlatform(
  nav: NavigatorLike = navigator as NavigatorLike,
): Promise<Platform> {
  const guess = fromUA(nav.userAgent, nav.maxTouchPoints);
  const data = nav.userAgentData;
  if (!data) return guess;
  const os = OS_BY_HINT[data.platform] ?? guess.os;
  try {
    const { architecture, bitness } = await data.getHighEntropyValues(["architecture", "bitness"]);
    const arch: Arch =
      architecture === "arm" && bitness === "64"
        ? "arm64"
        : architecture === "x86"
          ? "x86_64"
          : guess.arch;
    return { os, arch };
  } catch {
    return { os, arch: guess.arch };
  }
}

export const OS_LABEL: Record<OS, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  android: "Android",
  ios: "iOS / iPadOS",
  chromeos: "ChromeOS",
  unknown: "your platform",
};
