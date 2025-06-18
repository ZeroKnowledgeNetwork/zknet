export type ClientState = {
  isAvailable: boolean;
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
