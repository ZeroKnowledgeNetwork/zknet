# ui-shots

Screenshots of the desktop client and the downloads page, taken from their production builds, with every visible
color measured as painted and graded against WCAG 2.2. The client runs in a plain browser under a faked Tauri
backend; the downloads page is served as its real origin, under its own Content-Security-Policy, and reads the live
release list.

```sh
pnpm nx run ui-shots:shots                                   # → packages/ui-shots/out/current/
pnpm nx run ui-shots:shots --label=after --env-file=<path>   # the downloads page built with <path>'s settings
pnpm nx run-many -t test,typecheck,lint -p ui-shots
```

`shots` builds `client` and `downloads` first (`dependsOn`), then writes to `out/<label>/` (git-ignored):

| file                   | what                                                                       |
| ---------------------- | -------------------------------------------------------------------------- |
| `client-<view>.png`    | the client at 1000×720, full page, in each view below                      |
| `downloads.png`        | the downloads page at 1280×900, full page                                  |
| `downloads-mobile.png` | the downloads page at 390×844, full page                                   |
| `measure.json`         | `{ cspErrors, focusRows, results }`: every row measured, per view          |
| `report.md`            | the verdict, what fails, what is accepted and why, the lowest passing rows |
| `build/downloads/`     | with `--env-file`: the downloads build it shot                             |

It **exits 1** when any text is below 4.5:1 (3:1 when large), any non-text part, icon or status dot is below 3:1, any
focus indicator is below 3:1 or missing, or the downloads page logs a CSP violation. Disabled controls are exempt. It
is not part of CI.

## Options

| option              | default                                                     | does                                                                                                                                                                                                                                                                                        |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--label <name>`    | `current`                                                   | the output folder, `out/<name>/`                                                                                                                                                                                                                                                            |
| `--env-file <path>` | none: `apps/downloads/dist` as built                        | the downloads page's settings (`apps/downloads/.env.example`'s keys), relative to the workspace root. Vite bakes them in at build time, so the page is rebuilt with them; they win over `apps/downloads/.env`, empty values included. Use the deployed settings to shoot the deployed page. |
| `--origin <url>`    | the env file's `VITE_SITE_URL`, else `https://get.zknet.io` | the origin the downloads page is served as. The release host answers CORS for the page's own origin only.                                                                                                                                                                                   |

Without `--env-file`, the downloads page is whatever `downloads:build` made from `apps/downloads/.env`, which may show
links the deployed page hides.

## Views

| view                              | backend     | what happens before the shot                                                                                                                                                                                                               |
| --------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `networks`                        | normal      | nothing: the network table, every status, the unreachable-source warning                                                                                                                                                                   |
| `connecting`                      | connecting  | Connect: the "Checking network…" alert, which never resolves                                                                                                                                                                               |
| `error`                           | fetch-error | Connect: the "not published" error                                                                                                                                                                                                         |
| `settings`                        | normal      | Settings → **Reset**: the success alert. The pointer stays on Reset, so the frame shows its **hover** state and tooltip on purpose: a hovered button is darker than a resting one. Reset, because Apply won't submit with the field empty. |
| `walletshield-idle`               | normal      | WalletShield before connecting: the RPC page's info alert                                                                                                                                                                                  |
| `walletshield`                    | normal      | Connect → WalletShield: the RPC endpoint table                                                                                                                                                                                             |
| `console`                         | normal      | Connect → expand the console                                                                                                                                                                                                               |
| `focus`                           | normal      | 25 Tab presses from a click at (1, 1), recording each focus indicator                                                                                                                                                                      |
| `downloads`                       |             | the page, then the same Tab traversal                                                                                                                                                                                                      |
| `downloads-mobile`                |             | the page at phone width                                                                                                                                                                                                                    |
| `guide-networks`                  | normal      | the quickstart guide's frames (scenario `guide`): the network live on 2026-11-12 before its first connect, under the shipped `tauri.conf.json` settings                                                                                    |
| `guide-connected`                 | normal      | Connect; the logo held mid-pulse, as a person would catch it                                                                                                                                                                               |
| `guide-walletshield`              | normal      | Connect → WalletShield → copy the first URL                                                                                                                                                                                                |
| `quickstart`, `quickstart-mobile` |             | the downloads site's `/quickstart/` at both widths, when the build has it                                                                                                                                                                  |

## The faked backend

`src/fixture.ts` answers the client's Tauri commands. Its data is typed against the client's own types
(`apps/client/src/utils`: `Listing`, `Prepared`, `NetworkServices`, `ZKNetClientCfg`), so a change to the backend's
contract fails `typecheck` here instead of shooting a blank screen. A command it doesn't know logs
`[ui-shots] unhandled invoke <cmd>` in the page and answers `null`.

| command                     | answers                                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `networks_list`             | four networks, one of each status (ready, available, cached, unpublished), and one unreachable source                                   |
| `network_fetch`             | normal: reports the walletshield binary cached, then the prepared network · connecting: never settles · fetch-error: rejects `notFound` |
| `cfg`                       | WalletShield on `:7071`, the API on `:7072`, the updater on                                                                             |
| `plugin:fs\|read_text_file` | a `services.json` with five RPC endpoints, one a testnet and one without a chain id                                                     |
| `plugin:app\|*`, `platform` | ZKNetwork Client 0.1.0 on `linux-x64`                                                                                                   |
| `plugin:store\|*`           | an in-memory store                                                                                                                      |

## How it measures

- **Colors are read through a canvas**, which resolves `oklab()` and `color-mix()` exactly as painted. Each element's
  backdrop is its ancestors' backgrounds composited from the root down, with `opacity` multiplied along the way.
  Background images are ignored; the theme's noise is off (`--fx-noise: none`).
- **Non-text parts** (inputs, checkboxes, status dots, the selected row) are graded on the best of fill, border and
  outline against what's around them. A button's, badge's or alert's fill is reported as `fill(info)` and not graded:
  its label identifies it (SC 1.4.11).
- **Icons and status dots are measured even though they're `aria-hidden`**: they carry the status.
- **Focus** is measured with real Tab presses: a programmatic `focus()` doesn't show `:focus-visible` on a button.
- **Accepted failures** are listed in `src/grade.ts` (`ALLOW`), each with why. Today there is one: the WalletShield
  tab is a radio input whose label and underline are pseudo-elements, which the walker can't see.
- **Frames are deterministic.** Transitions are finished and infinite animations rested before a shot, and Chromium
  rasterizes the whole page on one thread: with partial raster, a rounded corner's anti-aliasing varied by a few
  pixels from run to run.
