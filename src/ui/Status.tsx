import React, { useEffect, useState } from "react";
import type { ReactNode } from "react";

/** Simple event-bus so any code can push a status message */
type StatusPayload = { id: number; content: ReactNode; timeout: number };
const EVENT = "app:status";
let _id = 0;

export function pushStatus(content: ReactNode, timeout = 2000) {
  const detail: StatusPayload = { id: ++_id, content, timeout };
  window.dispatchEvent(new CustomEvent(EVENT, { detail }));
}

function onStatus(handler: (p: StatusPayload) => void) {
  const fn = (e: Event) => handler((e as CustomEvent<StatusPayload>).detail);
  window.addEventListener(EVENT, fn as EventListener);
  return () => window.removeEventListener(EVENT, fn as EventListener);
}

/** Renders the stack of toasts in the bottom-left */
export function StatusViewport() {
  const [items, setItems] = useState<{ id: number; content: ReactNode }[]>([]);

  useEffect(() => {
    const off = onStatus(({ id, content, timeout }) => {
      setItems((prev) => [...prev, { id, content }]);
      window.setTimeout(() => {
        setItems((prev) => prev.filter((x) => x.id !== id));
      }, timeout);
    });
    return off;
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        left: 16,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        zIndex: 9999,
        pointerEvents: "none",
      }}
    >
      {items.map((it) => (
        <div
          key={it.id}
          style={{
            pointerEvents: "auto",
            background: "rgba(30,30,30,0.92)",
            color: "#fff",
            padding: "8px 12px",
            borderRadius: 8,
            boxShadow: "0 2px 10px rgba(0,0,0,0.35)",
            maxWidth: 380,
            fontSize: 14,
          }}
        >
          {it.content}
        </div>
      ))}
    </div>
  );
}
