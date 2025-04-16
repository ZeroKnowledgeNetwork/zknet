import { useEffect, useRef, useState } from "react";
import { check, Update } from "@tauri-apps/plugin-updater";
import * as log from "@tauri-apps/plugin-log";
import { useStore } from "../store";
import { IconArrowPath } from "./icons";

export function Updater() {
  const dlProgress = useRef(0);
  const dlTotal = useRef(0);
  const [dlPercent, setDlPercent] = useState(0);

  const consoleAddLine = useStore((s) => s.consoleAddLine);
  const status = useStore((s) => s.updateStatus);
  const setStatus = useStore((s) => s.setUpdateStatus);

  const [error, setError] = useState<string | null>(null);
  const [update, setUpdate] = useState<Update | null>(null);

  // run once on startup (twice in dev mode)
  useEffect(() => {
    checkForUpdates();
  }, []);

  const checkForUpdates = async () => {
    try {
      setStatus("checking");
      const u = await check({ timeout: 10000 });
      setUpdate(u);
      if (u) {
        setStatus("checked-updatable");
        const o = `Update available: ${u.currentVersion} => ${u.version}`;
        log.info(o);
        consoleAddLine(o);
      } else {
        setStatus("checked-current");
        consoleAddLine("App is up to date.");
      }
    } catch (error: any) {
      setStatus("error");
      setError(`${error}`);
      log.error(`update: ${error}`);
    }
  };

  const handleUpdate = async () => {
    if (!update) return;

    setStatus("starting");
    setDlPercent(0);
    dlProgress.current = 0;
    dlTotal.current = 0;

    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          setStatus("downloading");
          dlTotal.current = event.data.contentLength ?? 0;
          log.info(`Update started: Downloading ${dlTotal.current} bytes.`);
          break;

        case "Progress":
          dlProgress.current += event.data.chunkLength;
          setDlPercent(
            Math.floor((dlProgress.current / dlTotal.current) * 100),
          );
          break;

        case "Finished":
          setStatus("downloaded");
          log.info(`Update download finished.`);
          break;
      }
    });

    setStatus("installed");
  };

  const updateStates: Record<
    string,
    {
      msg?: string;
      progress?: boolean;
      value?: number;
      max?: number;
    }
  > = {
    "": {},
    error: {},
    checking: {
      msg: "Checking for updates...",
      progress: true,
    },
    "checked-current": {
      msg: "Up to date.",
    },
    "checked-updatable": {
      msg: `An update is available: ${update?.version}`,
    },
    starting: {
      msg: "Starting update...",
      progress: true,
    },
    downloading: {
      msg: `Downloading update... ${dlPercent}%`,
      progress: true,
      value: dlPercent,
      max: 100,
    },
    downloaded: {
      msg: "Update downloaded. Installing...",
      progress: true,
    },
    installed: {
      msg: "Update installed. Restart the app to ensure changes.",
    },
  };

  const { msg, progress, value, max } = updateStates[status];

  return (
    <div className="flex flex-col items-center py-4">
      <fieldset className="fieldset w-sm bg-base-200 border border-base-300 p-4 rounded-box">
        <legend className="fieldset-legend">
          <IconArrowPath className="size-5" /> Updates
        </legend>

        {!error && (
          <div className="flex flex-col gap-y-4">
            <span className="flex items-center gap-x-4">
              {msg}
              {status === "checked-updatable" && (
                <button
                  onClick={handleUpdate}
                  className="btn btn-sm btn-soft btn-accent mx-auto"
                >
                  Update Now
                </button>
              )}
            </span>
            {progress && (
              <progress
                className="progress progress-accent"
                value={value}
                max={max}
              />
            )}
          </div>
        )}

        {error && (
          <div role="alert" className="alert alert-error">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-6 w-6 shrink-0 stroke-current"
              fill="none"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <span>{error}</span>
          </div>
        )}
      </fieldset>
    </div>
  );
}
