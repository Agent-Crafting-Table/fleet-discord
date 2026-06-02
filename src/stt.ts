/**
 * stt.ts — Speech-to-text via a local OpenAI-compatible STT endpoint.
 *
 * POSTs decoded Opus audio as WAV to a local whisper/speaches container.
 * Audio pipeline: framed Opus packets → decode to PCM via prism-media → WAV
 * envelope → multipart POST to the STT endpoint.
 *
 * Required env vars:
 *   VOICE_STT_URL   URL of the local STT endpoint
 *                   e.g. http://localhost:8010/v1/audio/transcriptions
 *                   (Systran/faster-whisper via speaches, OpenAI-Whisper, etc.)
 *
 * Optional env vars:
 *   VOICE_STT_MODEL  Model name sent in the multipart form (default: Systran/faster-whisper-small)
 */

import prism from 'prism-media'
import { Readable } from 'stream'

const STT_URL = process.env.VOICE_STT_URL
if (!STT_URL) {
  throw new Error(
    'stt.ts: VOICE_STT_URL env var is required. ' +
    'Set it to your local STT endpoint, e.g. http://localhost:8010/v1/audio/transcriptions'
  )
}
const STT_MODEL = process.env.VOICE_STT_MODEL ?? 'Systran/faster-whisper-small'

function splitFramedOpusPackets(opusBuffer: Buffer): Buffer[] {
  const packets: Buffer[] = []
  let offset = 0
  while (offset + 4 <= opusBuffer.length) {
    const len = opusBuffer.readUInt32BE(offset)
    offset += 4
    if (len === 0 || offset + len > opusBuffer.length) return [opusBuffer]
    packets.push(opusBuffer.subarray(offset, offset + len))
    offset += len
  }
  return offset === opusBuffer.length && packets.length > 0 ? packets : [opusBuffer]
}

async function decodeOpusToPcm(opusBuffer: Buffer): Promise<Buffer> {
  if (opusBuffer.length === 0) return Buffer.alloc(0)

  return await new Promise<Buffer>((resolve, reject) => {
    const decoder = new (prism as any).opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 })
    const chunks: Buffer[] = []

    decoder.on('data', (chunk: Buffer) => chunks.push(chunk))
    decoder.on('end', () => resolve(Buffer.concat(chunks)))
    decoder.on('error', reject)

    const input = Readable.from(splitFramedOpusPackets(opusBuffer))
    input.on('error', reject)
    input.pipe(decoder)
  })
}

function pcmToWav(pcm: Buffer, sampleRate = 48000, channels = 2, bitDepth = 16): Buffer {
  const byteRate = sampleRate * channels * (bitDepth / 8)
  const blockAlign = channels * (bitDepth / 8)
  const dataSize = pcm.length
  const wav = Buffer.allocUnsafe(44 + dataSize)

  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + dataSize, 4)
  wav.write('WAVE', 8)
  wav.write('fmt ', 12)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(channels, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(byteRate, 28)
  wav.writeUInt16LE(blockAlign, 32)
  wav.writeUInt16LE(bitDepth, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(dataSize, 40)
  pcm.copy(wav, 44)
  return wav
}

export async function transcribe(opusBuffer: Buffer): Promise<string> {
  const pcm = await decodeOpusToPcm(opusBuffer)
  if (pcm.length === 0) return ''

  const wav = pcmToWav(pcm)
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', STT_MODEL)
  form.append('language', 'en')

  const res = await fetch(STT_URL, {
    method: 'POST',
    body: form,
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`STT HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
  }

  const json = await res.json() as { text?: string }
  return (json.text ?? '').trim()
}
