import React, { useEffect, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import { fmtTime } from '../lib/format'

interface Props {
  url: string
  onReady?: (dur: number) => void
  onTime?: (t: number) => void
  playing: boolean
}

export default function Waveform({ url, onReady, onTime, playing }: Props) {
  const ref = useRef<HTMLDivElement | null>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const [duration, setDuration] = useState(0)
  const [time, setTime] = useState(0)
  const [cursorLeft, setCursorLeft] = useState(0)

  useEffect(() => {
    if (!ref.current) return
    const ws = WaveSurfer.create({
      container: ref.current,
      waveColor: '#dcdcdc',
      progressColor: '#a3a3a3',
      cursorWidth: 0,
      height: 120,
      barWidth: 2,
      barGap: 1,
    })
    wsRef.current = ws
    ws.on('ready', () => {
      const dur = ws.getDuration()
      setDuration(dur)
      onReady?.(dur)
    })
    ws.on('timeupdate', (t) => {
      setTime(t)
      onTime?.(t)
      if (ref.current) {
        const w = ref.current.clientWidth
        const pos = ws.getCurrentTime() / (ws.getDuration() || 1)
        setCursorLeft(w * pos)
      }
    })
    ws.load(url)
    return () => { ws.destroy() }
  }, [url])

  useEffect(() => {
    const ws = wsRef.current
    if (!ws) return
    if (playing) ws.play(); else ws.pause()
  }, [playing])

  useEffect(() => {
    const handler = (e: Event) => {
      const ws = wsRef.current
      if (!ws) return
      const any = e as any
      const dt = any.detail || 0
      const t = Math.max(0, Math.min(ws.getDuration(), ws.getCurrentTime() + dt))
      ws.setTime(t)
    }
    window.addEventListener('seekrel' as any, handler)
    return () => window.removeEventListener('seekrel' as any, handler)
  }, [])

  return (
    <div className="col">
      <div className="wave-wrap">
        <div ref={ref} />
        <div className="red-line" style={{ left: cursorLeft }} />
      </div>
      <div className="wave-times">
        <div>{fmtTime(time)}</div>
        <div>{fmtTime(duration)}</div>
      </div>
    </div>
  )
}
