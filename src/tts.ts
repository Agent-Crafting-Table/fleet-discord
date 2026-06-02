/**
 * tts.ts — Text-to-speech via a local OpenAI-compatible TTS endpoint.
 *
 * POSTs text to a local TTS container (Kokoro/speaches or any compatible
 * OpenAI TTS endpoint). Returns mp3 bytes; StreamType.Arbitrary plays
 * cleanly via ffmpeg in @discordjs/voice.
 *
 * Required env vars:
 *   VOICE_TTS_URL   URL of the local TTS endpoint
 *                   e.g. http://localhost:8010/v1/audio/speech
 *
 * Optional env vars:
 *   VOICE_TTS_MODEL  Model name (default: tts-1)
 *   VOICE_TTS_VOICE  Voice name (default: af_heart — Kokoro voice; swap for yours)
 */

import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  NoSubscriberBehavior,
  StreamType,
  type VoiceConnection,
} from '@discordjs/voice'
import { Readable } from 'stream'

const TTS_URL = process.env.VOICE_TTS_URL
if (!TTS_URL) {
  throw new Error(
    'tts.ts: VOICE_TTS_URL env var is required. ' +
    'Set it to your local TTS endpoint, e.g. http://localhost:8010/v1/audio/speech'
  )
}
const TTS_MODEL = process.env.VOICE_TTS_MODEL ?? 'tts-1'
const TTS_VOICE = process.env.VOICE_TTS_VOICE ?? 'af_heart'

export async function synthesize(text: string): Promise<Buffer> {
  const res = await fetch(TTS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: TTS_MODEL,
      input: text,
      voice: TTS_VOICE,
      response_format: 'mp3',
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`TTS HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
  }

  return Buffer.from(await res.arrayBuffer())
}

export async function speak(text: string, connection: VoiceConnection): Promise<void> {
  if (!text.trim()) return
  const mp3 = await synthesize(text)
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } })
  // StreamType.Arbitrary tells @discordjs/voice to pipe through ffmpeg — correct for mp3.
  const resource = createAudioResource(Readable.from(mp3), { inputType: StreamType.Arbitrary })
  connection.subscribe(player)
  player.play(resource)
  await entersState(player, AudioPlayerStatus.Idle, 120_000)
}
