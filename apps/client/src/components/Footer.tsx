import { useStore } from "../store";
import { IconCommandLine } from ".";

export function Footer() {
  const appVersion = useStore((s) => s.appVersion);
  const platformArch = useStore((s) => s.platformArch);
  const consoleLines = useStore((s) => s.consoleLines);

  return (
    <div>
      <div className="bg-base-200 text-base-content/30 border-t border-base-300 rounded-none flex w-full items-center py-2">
        <div className="mx-auto flex gap-x-4 text-sm">
          <span>ZKNetwork Client</span>
          <span>|</span>
          <span>Version: {appVersion}</span>
          <span>|</span>
          <span>Platform: {platformArch}</span>
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
