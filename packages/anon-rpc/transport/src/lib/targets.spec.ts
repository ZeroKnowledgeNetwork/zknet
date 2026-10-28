import { classifyTarget } from "./targets.js";

describe("classifyTarget", () => {
  it.each([
    ["http://127.0.0.1:7070", "loopback"],
    ["http://127.8.9.10:7070", "loopback"],
    ["http://localhost:7070", "loopback"],
    ["http://LOCALHOST:7070", "loopback"],
    ["http://[::1]:7070", "loopback"],
    ["http://10.1.2.3:7070", "lan"],
    ["http://172.16.0.1:7070", "lan"],
    ["http://172.31.255.255:7070", "lan"],
    ["http://192.168.1.20:7070", "lan"],
    ["http://169.254.3.4:7070", "lan"],
    ["http://zknet-box.local:7070", "lan"],
    ["http://[fd12:3456::1]:7070", "lan"],
    ["http://[fe80::1]:7070", "lan"],
    ["http://[::ffff:192.168.1.2]:7070", "lan"],
    ["http://[::ffff:127.0.0.1]:7070", "loopback"],
    ["ws://127.0.0.1:30000/", "loopback"],
  ])("%s → %s", (url, cls) => {
    expect(classifyTarget(new URL(url))).toBe(cls);
  });

  it.each([
    "http://8.8.8.8:7070",
    "http://172.32.0.1:7070",
    "http://172.15.255.255:7070",
    "http://11.0.0.1:7070",
    "http://example.com:7070",
    "http://localhost.example.com:7070",
    "http://local:7070",
    "http://[2001:db8::1]:7070",
    "http://[::ffff:8.8.8.8]:7070",
  ])("%s is refused", (url) => {
    expect(classifyTarget(new URL(url))).toBeUndefined();
  });
});
