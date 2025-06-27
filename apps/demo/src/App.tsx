import { useEffect, useState } from 'react';
import reactLogo from './assets/react.svg';
import viteLogo from '/vite.svg';
import zknLogo from './assets/zkn.svg';
import { ZKNetSDK } from '@zknet/sdk';
import type { ZKNetSDKOptions } from '@zknet/sdk';
import './App.css';

function App() {
  const zknetOpts: ZKNetSDKOptions = {};

  const [fetchResult, setFetchResult] = useState<string | null>(null);

  const [hasZKNet, setHasZKNet] = useState<boolean>(false);
  useEffect(() => {
    ZKNetSDK.init(zknetOpts)
      .then(() => setHasZKNet(true))
      .catch(() => setHasZKNet(false));
  }, []);

  async function handleFetch() {
    setFetchResult('');

    try {
      const zknet = await ZKNetSDK.init(zknetOpts);

      const r = await zknet.fetch('/ethereum', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: '1729115977487',
          jsonrpc: '2.0',
          method: 'eth_chainId',
          params: [],
        }),
      });

      if (!r.ok)
        throw new Error(`[demo] Fetch failed: ${r.status} ${r.statusText}`);

      const data = await r.json();
      console.log('[demo] Fetch successful:', data);
      setFetchResult(JSON.stringify(data));
    } catch (err) {
      console.log('[demo] Fetch error:', err);
      setFetchResult(`${err}`);
    }
  }

  return (
    <>
      <div className="flex justify-center">
        <a href="https://vite.dev" target="_blank">
          <img src={viteLogo} className="logo" alt="Vite logo" />
        </a>
        <a href="https://react.dev" target="_blank">
          <img src={reactLogo} className="logo react" alt="React logo" />
        </a>
        <a href="https://zknet.io" target="_blank">
          <img src={zknLogo} className="logo zkn" alt="ZKN logo" />
        </a>
      </div>
      <h1>Vite + React + ZKNetwork</h1>
      <h2>Quickstart Template</h2>
      <div className="card card-border bg-base-200 mt-4">
        <div className="card-body">
          <button className="btn btn-primary" onClick={handleFetch}>
            zknet.fetch
          </button>
          <p>{fetchResult}</p>
        </div>
      </div>

      <div className="card card-border bg-base-200 mt-4">
        <div className="card-body">
          {hasZKNet && <span>ZKNet Extension is installed</span>}
          {hasZKNet || <span>ZKNet Extension is not installed</span>}
        </div>
      </div>
    </>
  );
}

export default App;
