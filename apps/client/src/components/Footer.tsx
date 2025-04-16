import { useEffect, useState } from "react";
import { useStore } from "../store";
import { IconArrowPath, IconCheckBadge, IconCommandLine } from ".";
import { Updater } from "./Updater";

export function Footer() {
  const appVersion = useStore((s) => s.appVersion);
  const consoleLines = useStore((s) => s.consoleLines);
  const platformArch = useStore((s) => s.platformArch);
  const updateStatus = useStore((s) => s.updateStatus);

  const [updaterKey, setUpdaterKey] = useState(0);
  const [updaterVisibility, setUpdaterVisibility] = useState(true);

  useEffect(() => {
    if (updateStatus === "checked-current") {
      const timer = setTimeout(() => setUpdaterVisibility(false), 3000);
      return () => clearTimeout(timer); // Cleanup on unmount
    }
  }, [updateStatus]);

  const isUpdaterVisible =
    updaterVisibility ||
    updateStatus === "checked-updatable" ||
    updateStatus === "installed";

  const showUpdater = () =>
    updateStatus === "error"
      ? setUpdaterKey((p) => p + 1) // remount to re-try updates
      : setUpdaterVisibility(true); // show but don't toggle

  return (
    <div>
      {isUpdaterVisible && <Updater key={updaterKey} />}
      <div className="bg-base-200 text-base-content/30 border-t border-base-300 rounded-none flex w-full items-center py-2">
        <div className="mx-auto flex gap-x-4 text-sm items-center">
          <span>ZKNetwork Client</span>
          <span>|</span>
          <span>Platform: {platformArch}</span>
          <span>|</span>
          <span onClick={showUpdater} className="flex items-center">
            Version: {appVersion}
            <button className="btn btn-ghost btn-xs btn-primary p-1">
              {updateStatus === "checked-current" ? (
                <IconCheckBadge className="size-5" />
              ) : (
                <IconArrowPath className="size-5" />
              )}
            </button>
          </span>
        </div>
      </div>
      <div className="collapse collapse-arrow bg-base-200 text-base-content/30 border-t border-base-300 rounded-none">
        <input type="checkbox" />
        <div className="collapse-title flex w-full items-center">
          <IconCommandLine />
        </div>
        <div className="collapse-content border-t border-base-300 px-4">
          <div className="flex h-36 flex-col-reverse overflow-y-scroll text-xs sm:text-xs md:text-sm lg:text-base text-base-content/50">
            {consoleLines.map((v, i) => (
              <span key={i}>{v}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
