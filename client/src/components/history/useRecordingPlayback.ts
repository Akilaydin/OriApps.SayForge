import { useCallback, useEffect, useRef, useState } from 'react'
import { loadAudioAsDataUrl } from '@/services/audioFileService'

let activeHistoryAudio: HTMLAudioElement | null = null
function claimHistoryPlayback(audio: HTMLAudioElement) {
  if (activeHistoryAudio && activeHistoryAudio !== audio) {
    activeHistoryAudio.pause()
  }
  activeHistoryAudio = audio
}
function releaseHistoryPlayback(audio: HTMLAudioElement) {
  if (activeHistoryAudio === audio) activeHistoryAudio = null
}

export function formatElapsed(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0
  const m = Math.floor(safe / 60)
  const s = Math.floor(safe % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export interface RecordingPlayback {
  playing: boolean
  loading: boolean
  ready: boolean
  currentTime: number
  duration: number
  playbackRate: number
  /** 0~1 */
  progress: number
  toggle: () => Promise<void>
  seek: (seconds: number) => void
  changeRate: (rate: number) => void
}

export function useRecordingPlayback(audioFilePath?: string, initialDurationSec = 0): RecordingPlayback {
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [ready, setReady] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(
    Number.isFinite(initialDurationSec) && initialDurationSec > 0 ? initialDurationSec : 0,
  )
  const [playbackRate, setPlaybackRate] = useState(1)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef<string>('')
  const rafRef = useRef<number>(0)

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current)
      if (audioRef.current) {
        releaseHistoryPlayback(audioRef.current)
        audioRef.current.pause()
        audioRef.current = null
      }
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current)
        audioUrlRef.current = ''
      }
    }
  }, [])

  useEffect(() => {
    function tick() {
      if (audioRef.current) {
        setCurrentTime(audioRef.current.currentTime)
      }
      if (playing) {
        rafRef.current = requestAnimationFrame(tick)
      }
    }
    if (playing) {
      rafRef.current = requestAnimationFrame(tick)
    }
    return () => cancelAnimationFrame(rafRef.current)
  }, [playing])

  const toggle = useCallback(async () => {
    if (!audioFilePath) return

    if (audioRef.current && playing) {
      audioRef.current.pause()
      setPlaying(false)
      return
    }

    if (audioRef.current && audioUrlRef.current) {
      audioRef.current.playbackRate = playbackRate
      await audioRef.current.play()
      setPlaying(true)
      return
    }

    setLoading(true)
    try {
      const dataUrl = await loadAudioAsDataUrl(audioFilePath)
      if (!dataUrl) {
        setLoading(false)
        return
      }
      const audio = new Audio(dataUrl)
      audioRef.current = audio
      audioUrlRef.current = dataUrl
      audio.playbackRate = playbackRate
      audio.onloadedmetadata = () => {
        setDuration(audio.duration)
        setReady(true)
      }
      audio.ontimeupdate = () => setCurrentTime(audio.currentTime)
      audio.onended = () => {
        releaseHistoryPlayback(audio)
        setPlaying(false)
        setCurrentTime(0)
      }
      audio.onpause = () => setPlaying(false)
      audio.onplay = () => {
        claimHistoryPlayback(audio)
        setPlaying(true)
      }
      await audio.play()
    } catch {
      // ignore playback errors
    } finally {
      setLoading(false)
    }
  }, [audioFilePath, playing, playbackRate])

  const seek = useCallback((seconds: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = seconds
      setCurrentTime(seconds)
    }
  }, [])

  const changeRate = useCallback((rate: number) => {
    setPlaybackRate(rate)
    if (audioRef.current) {
      audioRef.current.playbackRate = rate
    }
  }, [])

  const progress = duration > 0 ? Math.min(currentTime / duration, 1) : 0

  return { playing, loading, ready, currentTime, duration, playbackRate, progress, toggle, seek, changeRate }
}
