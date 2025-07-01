import { RPCEndpoints } from '../components';

export function WalletShield() {
  return (
    <div className="tabs tabs-border">
      <input
        type="radio"
        name="tabs_1"
        className="tab"
        aria-label="RPC Endpoints"
        defaultChecked
      />
      <div className="tab-content border-base-300 bg-base-100">
        <RPCEndpoints />
      </div>
    </div>
  );
}
