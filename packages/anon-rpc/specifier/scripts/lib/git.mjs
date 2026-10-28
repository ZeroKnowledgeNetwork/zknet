// The few git facts a public-tier deploy records or gates on.

import { execFileSync } from "node:child_process";
import { WORKSPACE_DIR } from "./paths.mjs";

/** @param {string[]} args @param {string} [cwd] */
const git = (args, cwd = WORKSPACE_DIR) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** @param {string} [cwd] @returns {string} full sha of HEAD */
export const head = (cwd) => git(["rev-parse", "HEAD"], cwd);

/** @param {string} [cwd] @returns {string} `git status --porcelain`, empty when clean */
export const porcelain = (cwd) => git(["status", "--porcelain"], cwd);

/** @param {string} [cwd] @returns {string} current branch, empty when detached */
export const branch = (cwd) => git(["branch", "--show-current"], cwd);

/** @param {string} [cwd] @returns {string[]} remote branches that contain HEAD */
export const remotesContainingHead = (cwd) =>
  git(["branch", "-r", "--contains", "HEAD"], cwd)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
