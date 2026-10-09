import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
const { invoke } = vi.hoisted(() => ({invoke:vi.fn()}))
vi.mock('@tauri-apps/api/core',()=>({invoke}))
vi.mock('@/services/bridge',()=>({storeGetSettings:vi.fn()}))
import { parseTestWav, prepareTestPcm, testCloudAsr } from '../asrTest'
import { asrConfigFromProfile } from '../asrConfig'
import { emptyAsrProfile } from '@/features/settings/asrProviderCatalog'

const fixture = () => new Uint8Array(readFileSync('src-tauri/resources/test_en.wav'))
describe('shared synthetic Cloud ASR test path',()=>{
  it('parses the actual bundled WAV and skips an unknown padded RIFF chunk',()=>{
    const bytes=fixture(), original=parseTestWav(bytes)
    expect(original.audioSec).toBeGreaterThan(1)
    const extra=new Uint8Array(bytes.length+12)
    extra.set(bytes.subarray(0,12)); extra.set([74,85,78,75,3,0,0,0,1,2,3,0],12); extra.set(bytes.subarray(12),24)
    new DataView(extra.buffer).setUint32(4,extra.length-8,true)
    expect(parseTestWav(extra)).toEqual(original)
  })
  it('rejects truncated, non-WAV, stereo, float, non-16k and empty/odd PCM',()=>{
    for(const mutate of [
      (b:Uint8Array)=>b.slice(0,20), (b:Uint8Array)=>{b[0]=0;return b},
      (b:Uint8Array)=>{b[20]=3;return b}, (b:Uint8Array)=>{b[22]=2;return b},
      (b:Uint8Array)=>{b[24]=0;return b},
      (b:Uint8Array)=>{new DataView(b.buffer).setUint32(40,0,true); return b.slice(0,44)},
      (b:Uint8Array)=>{new DataView(b.buffer).setUint32(40,1,true);return b},
    ]) expect(()=>parseTestWav(mutate(fixture()))).toThrow('16 kHz mono PCM16 WAV')
  })
  it('tests explicit draft credentials, prompts and codec without reading saved settings',async()=>{
    const profile={...emptyAsrProfile(),model:'draft-model',apiUrl:'https://draft.invalid/v1',apiKey:'draft-key',systemInstruction:'Synthetic instruction',userPrompt:'Synthetic prompt',protocol:'chat_standard' as const}
    const config=asrConfigFromProfile(profile)
    invoke.mockReset().mockResolvedValueOnce(Buffer.from(fixture()).toString('base64')).mockResolvedValueOnce({text:' Synthetic ',elapsed_ms:1})
    const audio=await prepareTestPcm(), result=await testCloudAsr(config,audio)
    expect(result.text).toBe('Synthetic')
    expect(invoke).toHaveBeenLastCalledWith('cloud_transcribe',{request:{audio_b64:audio.pcmB64,sample_rate:16000,asr_config:expect.objectContaining({api_key:'draft-key',extra:expect.objectContaining({model:'draft-model',baseUrl:'https://draft.invalid/v1',audioEncoding:'mp3',instructions:'Synthetic instruction',userPrompt:'Synthetic prompt'})})}})
    expect(invoke).toHaveBeenCalledTimes(2)
  })
  it('preserves empty results and propagates API/fixture errors',async()=>{
    const config=asrConfigFromProfile(emptyAsrProfile())
    invoke.mockReset().mockResolvedValueOnce({text:'  ',elapsed_ms:1}).mockRejectedValueOnce(new Error('Synthetic API failure')).mockResolvedValueOnce('invalid base64')
    expect((await testCloudAsr(config,{pcmB64:'AA==',audioSec:1})).text).toBe('')
    await expect(testCloudAsr(config,{pcmB64:'AA==',audioSec:1})).rejects.toThrow('Synthetic API failure')
    await expect(prepareTestPcm()).rejects.toThrow()
  })
})
