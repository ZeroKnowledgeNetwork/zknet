import { useStore } from "../store";

export function Footer() {
  const appVersion = useStore((s) => s.appVersion);
  const platformArch = useStore((s) => s.platformArch);
  return (
    <footer className="footer footer-center bg-base-200 text-base-content/30 p-4">
      <div className="flex flex-row">
        <span>ZKNetwork Client</span>
        <span className="mx-2">|</span>
        <span>Version: {appVersion}</span>
        <span className="mx-2">|</span>
        <span>Platform: {platformArch}</span>
      </div>
    </footer>
  );
}
