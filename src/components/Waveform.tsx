import React, { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { fmtTime } from "../lib/format";

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

  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [cursorLeft, setCursorLeft] = useState(0);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = Math.max(0, Math.min(1, volume));
    }
  }, [volume]);

  useEffect(() => {
    // reset visuals immediately to avoid showing the old track
    setDuration(0);
    setTime(0);
    setCursorLeft(0);

    const container = containerRef.current;
    if (!container || !url) {
      onAudioLoading?.(false);
      onWaveLoading?.(false);
      // destroy any previous
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

    // ensure a single reusable <audio>
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.preload = "auto";
      audioRef.current.crossOrigin = "anonymous";
      audioRef.current.style.display = "none";
      container.appendChild(audioRef.current);
    }

    const audio = audioRef.current;
    audio.volume = Math.max(0, Math.min(1, volume));
    audio.pause();
    audio.removeAttribute("src"); // in case something is still loading
    audio.load();

    const onLoadedMetadata = () => {
      try {
        // (re)create wavesurfer bound to the media element
        wsRef.current?.destroy();
        const ws = WaveSurfer.create({
          container,
          waveColor: "#dcdcdc",
          progressColor: "#a3a3a3",
          cursorWidth: 0,
          height: 120,
          barWidth: 2,
          barGap: 1,
          media: audio,
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

    const onCanPlay = () => onAudioLoading?.(false);
    const onError = (e: any) => {
      console.error("[audio] error", e);
      onAudioLoading?.(false);
      onWaveLoading?.(false);
    };

    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("canplay", onCanPlay);
    audio.addEventListener("error", onError);

    // finally set the new source and kick loading
    console.debug("[Waveform] setting audio.src =", url);
    if (!url || typeof url !== "string") {
      onAudioLoading?.(false);
      onWaveLoading?.(false);
      return;
    }
    audio.src = url;
    audio.load();

    return () => {
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("error", onError);

      wsRef.current?.destroy();
      wsRef.current = null;

      // hard stop & clear src to kill any pending decode
      audio.pause();
      audio.removeAttribute("src");
      audio.load();

      onAudioLoading?.(false);
      onWaveLoading?.(false);
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
