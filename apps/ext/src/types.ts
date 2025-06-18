export type ClientState = {
  // is the ZKNetwork Client Application running locally
  isAvailable: boolean;

  // is the ZKNetwork Client Application connected to a network
  isConnected: boolean;
};

export type RemoteClientStatus = {
  app: {
    version: string;
  };
  network: {
    isConnected: boolean;
  };
  settings: {
    walletshield: {
      listenAddress: string;
    };
  };
};
