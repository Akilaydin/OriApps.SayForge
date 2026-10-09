import { describe, it, expect } from 'vitest'
import { uint8ArrayToBase64 } from '../encoding'

describe('uint8ArrayToBase64', () => {
  it('encodes an empty array as an empty string', () => {
    expect(uint8ArrayToBase64(new Uint8Array(0))).toBe('')
  })

  it('encodes small buffers', () => {
    const data = new Uint8Array([72, 101, 108, 108, 111]) // "Hello"
    expect(uint8ArrayToBase64(data)).toBe(btoa('Hello'))
  })

  it('encodes buffers larger than one chunk', () => {
    const size = 20000
    const data = new Uint8Array(size)
    for (let i = 0; i < size; i++) {
      data[i] = i % 256
    }
    let expected = ''
    for (let i = 0; i < data.length; i++) {
      expected += String.fromCharCode(data[i])
    }
    expected = btoa(expected)

    expect(uint8ArrayToBase64(data)).toBe(expected)
  })

  it('encodes a single byte', () => {
    const data = new Uint8Array([65]) // "A"
    expect(uint8ArrayToBase64(data)).toBe('QQ==')
  })
})
