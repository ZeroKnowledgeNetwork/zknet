import { useEffect } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import * as app from "@tauri-apps/api/app";
import * as log from "@tauri-apps/plugin-log";
import { arch, platform } from "@tauri-apps/plugin-os";
import { Footer, Header, Message } from "./components";
import { Networks, Settings } from "./pages";
import { useStore } from "./store";
import { getNetworks, getPlatformArch } from "./utils";
import "./App.css";

function App() {
  const setAppVersion = useStore((s) => s.setAppVersion);
  const setIsPlatformSupported = useStore((s) => s.setIsPlatformSupported);
  const setMessage = useStore((s) => s.setMessage);
  const setNetworks = useStore((s) => s.setNetworks);
  const setPlatformArch = useStore((s) => s.setPlatformArch);

  // run once on startup (twice in dev mode)
  useEffect(() => {
    try {
      (async () => {
        const name = await app.getName();
        const v = "v" + (await app.getVersion());
        log.info(`Starting ${name} ${v} on ${platform()}-${arch()}`);

        setAppVersion(v);
        setPlatformArch(getPlatformArch());
        setIsPlatformSupported(true);
        setNetworks(await getNetworks());
      })();
    } catch (error: any) {
      log.error(`${error}`);
      setMessage("error", `${error}`);
    }
  }, []);

  return (
    <MemoryRouter>
      <div className="flex flex-col min-h-screen gap-y-4">
        <Header />
        <main className="flex-grow flex flex-col gap-y-4">
          <Routes>
            <Route path="/" element={<Networks />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
          <Message />
        </main>
        <Footer />
      </div>
    </MemoryRouter>
  );
}

export default App;
