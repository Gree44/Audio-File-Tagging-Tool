import React, { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { fmtTime } from "../lib/format";

interface Props {
  url: string;
  onReady?: (dur: number) => void;
  onTime?: (t: number) => void;
  playing: boolean;
  volume: number;
}

export default function Waveform({
  url,
  onReady,
  onTime,
  playing,
  volume,
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

  // (Re)create wavesurfer when URL changes; use a real <audio> element
  useEffect(() => {
    if (!containerRef.current || !url) return;

    // ensure audio element exists & points to our URL
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.preload = "auto";
      audioRef.current.crossOrigin = "anonymous";
      audioRef.current.style.display = "none";
      // optional: append so WebKit keeps it alive
      containerRef.current.appendChild(audioRef.current);
    }
    audioRef.current.src = url;
    console.info("Volume set to", audioRef.current.volume);
    audioRef.current.volume = Math.max(0, Math.min(1, volume));

    try {
      const ws = WaveSurfer.create({
        container: containerRef.current,
        // visual config
        waveColor: "#dcdcdc",
        progressColor: "#a3a3a3",
        cursorWidth: 0,
        height: 120,
        barWidth: 2,
        barGap: 1,
        // key bit: provide the media element so no fetch/XHR occurs
        media: audioRef.current,
      });
      wsRef.current = ws;

      ws.on("ready", () => {
        const dur = ws.getDuration();
        setDuration(dur);
        onReady?.(dur);
      });
      ws.on("timeupdate", (t) => {
        setTime(t);
        onTime?.(t);
        if (containerRef.current) {
          const w = containerRef.current.clientWidth;
          const pos = ws.getDuration()
            ? ws.getCurrentTime() / ws.getDuration()
            : 0;
          setCursorLeft(w * pos);
        }
      });
      ws.on("error", (e: any) => {
        console.error("[WaveSurfer] error", e);
      });

      // trigger load by telling the audio element to load
      audioRef.current!.load();
    } catch (e) {
      console.error("[WaveSurfer] create failed", e);
    }

    return () => {
      wsRef.current?.destroy();
      wsRef.current = null;
      // keep the audio element for reuse across urls; comment-out next two lines if you prefer to fully tear down
      // audioRef.current?.remove()
      // audioRef.current = null
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
