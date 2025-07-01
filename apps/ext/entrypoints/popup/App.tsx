import { useState, useEffect } from 'react';
import zknLogo from '@/assets/zkn.svg';
import { extensionMsgr } from '@/src/messaging/extension';
import type { ClientState } from '@/src/types';
import './App.css';

function App() {
  const [clientState, setClientState] = useState<ClientState>({
    isAvailable: false,
    isConnected: false,
  });

  useEffect(() => {
    // Get initial state
    extensionMsgr
      .sendMessage('zknet.client.getState', undefined)
      .then(setClientState)
      .catch((err) => {
        console.warn('Failed to fetch initial client state:', err);
      });

    // Subscribe to state updates
    const unwatch = extensionMsgr.onMessage('zknet.client.state', ({ data }) =>
      setClientState(data),
    );

    return unwatch;
  }, []);

  const { isAvailable, isConnected } = clientState || {};

  return (
    <div className=" w-80">
      <h1 className="text-xl font-bold text-center mb-4">
        Zero Knowledge Network
      </h1>
      <div className="flex justify-center mb-4">
        <img
          src={zknLogo}
          className={`logo ${isConnected ? 'pulsing' : ''}`}
          alt="ZKN logo"
        />
      </div>

      <div className="card card-border bg-base-200">
        <div className="card-body">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div
                className={`w-3 h-3 rounded-full ${
                  isAvailable ? 'bg-success' : 'bg-error'
                }`}
              ></div>
              <span>Client {isAvailable ? 'Running' : 'Not Running'}</span>
            </div>

            <div className="flex items-center gap-2">
              <div
                className={`w-3 h-3 rounded-full ${
                  isConnected ? 'bg-success' : 'bg-warning'
                }`}
              ></div>
              <span>Network {isConnected ? 'Connected' : 'Not Connected'}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
