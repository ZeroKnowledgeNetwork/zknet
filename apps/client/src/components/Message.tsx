import { useStore } from "../store";

export function Message() {
  const msg = useStore((s) => s.message);
  const msgType = useStore((s) => s.messageType);

  const msgClass =
    {
      error: "alert-error",
      info: "alert-info",
      success: "alert-success",
    }[msgType] ?? "";

  return (
    <>
      {msg && (
        <div className="flex justify-center">
          <p className={`alert ${msgClass}`}>{msg}</p>
        </div>
      )}
    </>
  );
}
