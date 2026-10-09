import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMicrophoneDigitalGain,
  isPseudoInputDevice,
  listMicrophones,
  matchRealEndpoint,
  MIC_DIGITAL_GAIN,
  microphoneCaptureConstraints,
  normalizeSelectedMicId,
  realInputEndpoints,
} from '../audio'

const HEADSET = 'Headset Microphone (Plantronics Blackwire 5220 Series) (047f:c053)'

function device(deviceId: string, label: string, kind = 'audioinput') {
  return { deviceId, groupId: 'plt-group', kind, label, toJSON: () => ({}) }
}

function stubEnumerate(list: ReturnType<typeof device>[]) {
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [] }))
  vi.stubGlobal('navigator', {
    mediaDevices: {
      enumerateDevices: vi.fn(async () => list),
      getUserMedia,
    },
  })
  return getUserMedia
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('microphone device list', () => {
  it('disables WebRTC gain changes for default and selected microphones', () => {
    expect(microphoneCaptureConstraints(undefined)).toEqual({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: false,
      },
    })
    expect(microphoneCaptureConstraints('headset', false)).toEqual({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        deviceId: { exact: 'headset' },
      },
    })
  })

  it('amplifies only the captured Web Audio stream', () => {
    const gainNode = { gain: { value: 1 } }
    const ctx = { createGain: vi.fn(() => gainNode) }
    const source = { connect: vi.fn() }

    expect(createMicrophoneDigitalGain(ctx as unknown as AudioContext, source as unknown as AudioNode)).toBe(gainNode)
    expect(gainNode.gain.value).toBe(MIC_DIGITAL_GAIN)
    expect(source.connect).toHaveBeenCalledWith(gainNode)
  })

  it('recognizes the two pseudo devices Chromium adds, and nothing else', () => {
    expect(isPseudoInputDevice('default')).toBe(true)
    expect(isPseudoInputDevice('communications')).toBe(true)
    expect(isPseudoInputDevice('DEFAULT')).toBe(true)
    expect(isPseudoInputDevice('  ')).toBe(true)
    expect(isPseudoInputDevice('a1b2c3')).toBe(false)
  })

  it('folds a stored pseudo-device id back to "follow system default"', () => {
    expect(normalizeSelectedMicId('default')).toBe('')
    expect(normalizeSelectedMicId('communications')).toBe('')
    expect(normalizeSelectedMicId('  ')).toBe('')
    expect(normalizeSelectedMicId(undefined)).toBe('')
    expect(normalizeSelectedMicId(123)).toBe('')
    expect(normalizeSelectedMicId('real-headset')).toBe('real-headset')
  })

  it('keeps the pseudo devices but drops non-inputs', async () => {
    stubEnumerate([
      device('default', `Default - ${HEADSET}`),
      device('communications', `Communications - ${HEADSET}`),
      device('real-headset', HEADSET),
      device('speaker', 'Speakers', 'audiooutput'),
    ])

    const mics = await listMicrophones()

    expect(mics.map((d) => d.deviceId)).toEqual(['default', 'communications', 'real-headset'])
  })

  it('resolves which real endpoint the system default currently points at', async () => {
    const devices = [
      { deviceId: 'default', groupId: 'plt-group', label: `Default - ${HEADSET}` },
      { deviceId: 'real-headset', groupId: 'plt-group', label: HEADSET },
    ]

    expect(matchRealEndpoint(devices[0], devices)?.deviceId).toBe('real-headset')
    expect(matchRealEndpoint(devices[1], devices)?.deviceId).toBe('real-headset')
    expect(matchRealEndpoint({ deviceId: 'default', groupId: 'gone', label: 'Default - Missing' }, devices))
      .toBeNull()
  })

  it('treats endpoints without a readable name as not identifiable', async () => {
    const devices = [
      { deviceId: 'a', groupId: 'g', label: '' },
      { deviceId: 'b', groupId: 'g', label: 'Real Mic' },
    ]
    expect(realInputEndpoints(devices).map((d) => d.deviceId)).toEqual(['b'])
  })

  it('still opens a temporary stream when labels are missing, judging by the raw list', async () => {
    const getUserMedia = stubEnumerate([device('', '')])

    await listMicrophones()

    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(getUserMedia).toHaveBeenCalledWith(microphoneCaptureConstraints(undefined))
  })
})
