import type { TransportErrorCode, TransportErrorShape, TransportFailure } from "./types.js";

/**
 * A transport failure. `code` is the Anon-RPC SPEC v0.3.2 §12 value a host branches on;
 * `name` is the finer, equally stable reason; `message` is diagnostic only.
 */
export class TransportError extends Error implements TransportErrorShape {
  override readonly name: TransportFailure;
  readonly code: TransportErrorCode;

  constructor(
    code: TransportErrorCode,
    name: TransportFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.code = code;
    this.name = name;
  }

  toJSON(): TransportErrorShape {
    return { code: this.code, name: this.name, message: this.message };
  }
}

/**
 * The `ZKNet-Error` reasons a peer or the exit originates, and what each
 * means here. A reason not in this table is still a transport failure
 * (`UnexpectedReply`): the header's presence is what marks it.
 */
export const ZKNET_ERROR_REASONS: Readonly<
  Record<string, { code: TransportErrorCode; name: TransportFailure }>
> = {
  "mix-timeout": { code: "timeout", name: "MixTimeout" },
  "exit-refused": { code: "permission-denied", name: "ExitRefused" },
  "upstream-unreachable": { code: "network-error", name: "UpstreamUnreachable" },
  "too-large": { code: "too-large", name: "TooLarge" },
  "bad-reply": { code: "protocol-error", name: "BadReply" },
  "exit-busy": { code: "queue-full", name: "ExitBusy" },
  "provider-selection-off": { code: "permission-denied", name: "ExitRefused" },
};

/** The TransportError for a peer reply carrying `ZKNet-Error: <reason>`. */
export function zknetError(reason: string, message?: string): TransportError {
  const known = Object.hasOwn(ZKNET_ERROR_REASONS, reason)
    ? ZKNET_ERROR_REASONS[reason]
    : undefined;
  const { code, name } = known ?? {
    code: "protocol-error" as const,
    name: "UnexpectedReply" as const,
  };
  return new TransportError(code, name, message ? `${reason}: ${message}` : reason);
}
