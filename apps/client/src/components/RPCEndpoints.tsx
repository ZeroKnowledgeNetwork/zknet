import { useState, useMemo, useEffect } from "react";
import { useStore } from "../store";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import * as log from "@tauri-apps/plugin-log";
import {
  NetworkServices,
  getZKNetClientCfg,
  readNetworkAssetFile,
} from "../utils";
import { IconClipboard } from "./icons";

export function RPCEndpoints() {
  const [includeTestnets, setIncludeTestnets] = useState(true);
  const [search, setSearch] = useState("");
  const [services, setServices] = useState<NetworkServices | null>();
  const [copied, setCopied] = useState("");
  const [
    defaultWalletshieldListenAddress,
    setDefaultWalletshieldListenAddress,
  ] = useState("");

  const networkConnected = useStore((s) => s.networkConnected);
  const setMessage = useStore((s) => s.setMessage);

  const walletshieldListenAddress = useStore(
    (s) => s.walletshieldListenAddress,
  );
  const wla = walletshieldListenAddress || defaultWalletshieldListenAddress;
  const BASE_URL = `http://localhost${wla}`;

  useEffect(() => {
    try {
      (async () => {
        const cfg = await getZKNetClientCfg();
        setDefaultWalletshieldListenAddress(
          cfg.defaultWalletshieldListenAddress,
        );

        // read services file of the connected network
        if (networkConnected) {
          const f = await readNetworkAssetFile(
            networkConnected,
            "services.json",
          );
          const s = JSON.parse(f) as NetworkServices;
          setServices(s);
        }
      })();
    } catch (error: any) {
      log.error(`${error}`);
      setMessage("error", `${error}`);
    }
  }, []);

  const handleCopy = async (rpcPath: string) => {
    await writeText(`${BASE_URL}${rpcPath}`);
    setCopied(rpcPath);
  };

  const filtered = useMemo(() => {
    if (!services) return [];
    const endpoints = services.RPCEndpoints;
    return endpoints
      .filter((n) => includeTestnets || !n.isTestnet)
      .filter((n) => {
        const term = search.toLowerCase();
        return (
          n.chain.toLowerCase().includes(term) ||
          n.network.toLowerCase().includes(term)
        );
      });
  }, [includeTestnets, search, services]);

  if (!networkConnected) {
    return (
      <div className="p-4 flex justify-center">
        <div className="alert alert-warning shadow-lg">
          <span>Connect to a network to see its supported RPC endpoints.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between mb-4 space-y-2 md:space-y-0">
        <div className="form-control flex flex-row gap-x-4">
          <label className="label">
            <span className="label-text">Search Networks</span>
          </label>
          <input
            type="text"
            placeholder="Search..."
            className="input input-bordered"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label className="label cursor-pointer">
            <span className="label-text">Include Testnets</span>
            <input
              type="checkbox"
              className="checkbox checkbox-primary"
              checked={includeTestnets}
              onChange={(e) => setIncludeTestnets(e.target.checked)}
            />
          </label>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="table w-full table-zebra">
          <thead>
            <tr>
              <th>Chain</th>
              <th>Network</th>
              <th>ChainID</th>
              <th>RPC URL</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((n, idx) => (
              <tr key={idx}>
                <td>{n.chain}</td>
                <td>{n.network}</td>
                <td>{n.chainId ?? ""}</td>
                <td
                  className="flex items-center gap-x-1 hover:cursor-pointer"
                  onClick={() => handleCopy(n.rpcPath)}
                >
                  <IconClipboard
                    className="size-5"
                    withCheck={copied === n.rpcPath}
                  />
                  {`${BASE_URL}${n.rpcPath}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
