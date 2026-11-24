import { useStore } from "../store";
import { IconStatus } from "./icons";

const ALERTS = {
  error: "alert-error",
  info: "alert-info",
  success: "alert-success",
} as const;

export function Message() {
  const msg = useStore((s) => s.message);
  const msgType = useStore((s) => s.messageType);

  const kind = msgType in ALERTS ? (msgType as keyof typeof ALERTS) : undefined;

  return (
    <>
      {msg && (
        <div className="flex justify-center">
          <p className={`alert ${kind ? ALERTS[kind] : ""}`}>
            {kind && <IconStatus kind={kind} />}
            {msg}
          </p>
        </div>
      )}
    </>
  );
}
