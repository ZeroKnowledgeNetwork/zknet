import { useEffect, useState } from "react";
import { useStore } from "../store";
import { getZKNetClientCfg } from "../utils";

export function Settings() {
  const [listenAddress, setListenAddress] = useState("");
  const [
    defaultWalletshieldListenAddress,
    setDefaultWalletshieldListenAddress,
  ] = useState("");

  const walletshieldListenAddress = useStore(
    (s) => s.walletshieldListenAddress,
  );

  const setMessage = useStore((s) => s.setMessage);
  const setWalletshieldListenAddress = useStore(
    (s) => s.setWalletshieldListenAddress,
  );

  useEffect(() => {
    setListenAddress(walletshieldListenAddress);
    (async () => {
      const cfg = await getZKNetClientCfg();
      setDefaultWalletshieldListenAddress(cfg.defaultWalletshieldListenAddress);
    })();
  }, []);

  const handleReset = () => {
    setListenAddress("");
    setWalletshieldListenAddress("");
    setMessage("success", "Settings reset to default.");
  };

  const handleApply = () => {
    setWalletshieldListenAddress(listenAddress);
    setMessage("success", "Settings saved.");
  };

  return (
    <div className="flex flex-col items-center h-full">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleApply();
        }}
      >
        <fieldset className="fieldset w-xs bg-base-200 border border-base-300 p-4 rounded-box">
          <legend className="fieldset-legend">Walletshield</legend>

          <label className="fieldset-label">Listen Address &amp; Port</label>
          <input
            type="text"
            className="input validator"
            placeholder={defaultWalletshieldListenAddress}
            value={listenAddress}
            onChange={(e) => setListenAddress(e.target.value)}
            pattern="^((\d{1,3}\.){3}\d{1,3}|[a-zA-Z0-9.-]+)?:(\d{1,5})$"
            required
          />
          <p className="fieldset-label">
            Where the Walletshield listens for connections.
          </p>
        </fieldset>
        <div className="flex w-full h-full gap-4 p-4">
          <div className="tooltip flex-1" data-tip="Restore Defaults">
            <button
              type="button"
              className="btn btn-secondary w-full"
              onClick={handleReset}
            >
              Reset
            </button>
          </div>
          <div className="tooltip flex-1" data-tip="Save Settings">
            <button type="submit" className="btn btn-primary w-full">
              Apply
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
