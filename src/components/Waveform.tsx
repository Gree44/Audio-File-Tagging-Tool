import React, { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { fmtTime } from "../lib/format";
import { fileBlobUrl } from "../tauri";

interface Props {
  url: string;
  onReady?: (dur: number) => void;
  onTime?: (t: number) => void;
  playing: boolean;
  volume: number;
  onAudioLoading?: (loading: boolean) => void;
  onWaveLoading?: (loading: boolean) => void;
}

export default function Waveform({
  url,
  onReady,
  onTime,
  playing,
  volume,
  onAudioLoading,
  onWaveLoading,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const triedBlobRef = useRef(false); // avoid infinite fallback loops
  const blobUrlRef = useRef<string | null>(null); // revoke on cleanup/switch

  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [cursorLeft, setCursorLeft] = useState(0);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = Math.max(0, Math.min(1, volume));
    }
  }, [volume]);

  useEffect(() => {
    // reset visuals immediately so old track doesn't linger
    setDuration(0);
    setTime(0);
    setCursorLeft(0);

    const container = containerRef.current;
    // reset fallback state and revoke any previous blob
    triedBlobRef.current = false;
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }

    if (!container || !url) {
      wsRef.current?.destroy();
      wsRef.current = null;
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.removeAttribute("src");
        audioRef.current.load();
      }
      return;
    }

    onAudioLoading?.(true);
    onWaveLoading?.(true);

    // persistent hidden <audio> attached to <body>
    if (!audioRef.current) {
      const el = document.createElement("audio");
      el.preload = "metadata"; // fast metadata first
      el.style.display = "none";
      document.body.appendChild(el);
      audioRef.current = el;
    }

    const audio = audioRef.current;
    audio.volume = Math.max(0, Math.min(1, volume));
    audio.pause();
    audio.removeAttribute("src");
    audio.load();

    const onLoadedMetadata = () => {
      try {
        wsRef.current?.destroy();
        const ws = WaveSurfer.create({
          container,
          waveColor: "#dcdcdc",
          progressColor: "#a3a3a3",
          cursorWidth: 0,
          height: 120,
          barWidth: 2,
          barGap: 1,
          media: audio, // bind to the element; no fetch
        });
        wsRef.current = ws;

        ws.on("ready", () => {
          const dur = ws.getDuration();
          setDuration(dur);
          onReady?.(dur);
          onWaveLoading?.(false);
        });
        ws.on("timeupdate", (t) => {
          setTime(t);
          onTime?.(t);
          const w = container.clientWidth;
          const pos = ws.getDuration()
            ? ws.getCurrentTime() / ws.getDuration()
            : 0;
          setCursorLeft(w * pos);
        });
        ws.on("error", (e: any) => {
          console.error("[WaveSurfer] error", e);
          onWaveLoading?.(false);
        });
      } catch (e) {
        console.error("[WaveSurfer] create failed", e);
        onWaveLoading?.(false);
      }
    };

    const pathFromUrl = (u: string): string | null => {
      if (!u) return null;
      const prefix = "asset://localhost/";
      if (u.startsWith(prefix)) {
        try {
          return decodeURIComponent(u.slice(prefix.length));
        } catch {}
      }
      if (u.startsWith("http://") || u.startsWith("https://")) {
        try {
          const url = new URL(u);
          const p = url.searchParams.get("path");
          if (p) return decodeURIComponent(p);
        } catch {}
      }
      if (u.startsWith("/")) return u;
      try {
        const dec = decodeURIComponent(u);
        if (dec.startsWith("/")) return dec;
      } catch {}
      return null;
    };

    const onCanPlay = () => onAudioLoading?.(false);

    const onError = async (e: any) => {
      console.error("[audio] error", e);
      // Fallback: build a Blob URL from disk and try again (once)
      if (!triedBlobRef.current) {
        const p = pathFromUrl(url);
        if (p) {
          triedBlobRef.current = true;
          try {
            console.warn(
              "[audio] asset:// failed; falling back to Blob for",
              p
            );
            onAudioLoading?.(true);
            const obj = await fileBlobUrl(p);
            if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
            blobUrlRef.current = obj;
            audio.src = obj;
            audio.load();
            return;
          } catch (err) {
            console.error("[audio] blob fallback failed", err);
          }
        }
      }
      onAudioLoading?.(false);
      onWaveLoading?.(false);
    };

    audio.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
    audio.addEventListener("canplay", onCanPlay, { once: true });
    // IMPORTANT: do NOT make error listener "once", so it can catch both asset and blob attempts
    audio.addEventListener("error", onError);

    console.debug("[Waveform] setting audio.src =", url);
    audio.src = url;
    audio.load();

    return () => {
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("error", onError);

      wsRef.current?.destroy();
      wsRef.current = null;

      audio.pause();
      audio.removeAttribute("src");
      audio.load();

      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [url]);

  // play/pause control
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    if (playing) ws.play();
    else ws.pause();
  }, [playing]);

  // support our custom seek events
  useEffect(() => {
    const handler = (e: Event) => {
      const ws = wsRef.current;
      if (!ws) return;
      const dt = (e as CustomEvent<number>).detail ?? 0;
      const t = Math.max(
        0,
        Math.min(ws.getDuration() || 0, ws.getCurrentTime() + dt)
      );
      ws.setTime(t);
    };
    window.addEventListener("seekrel", handler as EventListener);
    return () =>
      window.removeEventListener("seekrel", handler as EventListener);
  }, []);

  return (
    <div className="col">
      <div className="wave-wrap">
        <div ref={containerRef} />
        <div className="red-line" style={{ left: cursorLeft }} />
      </div>
      <div className="wave-times">
        <div>{fmtTime(time)}</div>
        <div>{fmtTime(duration)}</div>
      </div>
    </div>
  );
}
