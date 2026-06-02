/**
 * voice.ts — VoiceManager for the fleet Discord plugin.
 *
 * Keeps all key patterns: proactive receiver.subscribe(), AfterSilence ~400ms,
 * drop utterances <300ms, /voice join|leave|mode commands, full vs listen mode,
 * 10-min inactivity auto-leave, auto-reconnect on Disconnected.
 *
 * Locks listening to a single user via DISCORD_VOICE_USER_ID env var (required).
 * Brain calls go to a local voice-bridge at VOICE_BRIDGE_URL (required).
 *
 * Required env vars:
 *   DISCORD_VOICE_USER_ID   Discord user ID to listen to (snowflake string)
 *
 * Optional env vars:
 *   VOICE_BRIDGE_URL        OpenAI-compatible chat completions endpoint for the brain
 *                           Default: http://localhost:18789/v1/chat/completions
 *   VOICE_BRIDGE_MODEL      Model name to use with the bridge
 *                           Default: voice-bridge
 *
 * This module is only imported when DISCORD_VOICE_ENABLED=1. Never import it
 * at top-level in server.ts — always use dynamic await import('./voice.js').
 */

import {
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
  VoiceConnectionStatus,
  type VoiceConnection,
} from '@discordjs/voice'
import { ChannelType, type ChatInputCommandInteraction, type Client, type VoiceBasedChannel } from 'discord.js'
import { transcribe } from './stt.js'
import { speak } from './tts.js'

const BRIDGE_URL = process.env.VOICE_BRIDGE_URL ?? 'http://localhost:18789/v1/chat/completions'
const BRIDGE_MODEL = process.env.VOICE_BRIDGE_MODEL ?? 'voice-bridge'

const MIN_UTTERANCE_MS = 300
const INACTIVITY_LEAVE_MS = 10 * 60 * 1000

export type VoiceMode = 'full' | 'listen'

type VoiceState = {
  guildId: string
  mode: VoiceMode
  voiceChannelId: string
  textChannelId: string
  connection: VoiceConnection
  speaking: boolean
  utteranceStartedAt: number
  chunks: Buffer[]
  stream?: NodeJS.ReadableStream & { destroy?: () => void }
  inactivityTimer?: ReturnType<typeof setTimeout>
}

type VoiceManagerOptions = {
  client: Client
  targetUserId?: string
  onTranscript: (args: { text: string; chatId: string; guildId: string; voiceChannelId: string }) => void | Promise<void>
}

async function callBrain(text: string): Promise<string> {
  const res = await fetch(BRIDGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: BRIDGE_MODEL,
      messages: [{ role: 'user', content: text }],
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`voice-bridge HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
  }

  const json = await res.json() as { choices?: { message?: { content?: string } }[] }
  return (json.choices?.[0]?.message?.content ?? '').trim()
}

export class VoiceManager {
  private client: Client
  private targetUserId: string
  private onTranscript: VoiceManagerOptions['onTranscript']
  private states = new Map<string, VoiceState>()

  constructor(opts: VoiceManagerOptions) {
    this.client = opts.client
    // targetUserId MUST be set via opts or DISCORD_VOICE_USER_ID env var.
    // There is no default — configuring the wrong user ID would silently
    // listen to the wrong person.
    const userId = opts.targetUserId ?? process.env.DISCORD_VOICE_USER_ID
    if (!userId) {
      throw new Error(
        'VoiceManager: DISCORD_VOICE_USER_ID env var is required. ' +
        'Set it to the Discord user ID (snowflake) of the user to listen to.'
      )
    }
    this.targetUserId = userId
    this.onTranscript = opts.onTranscript
  }

  async joinFromInteraction(interaction: ChatInputCommandInteraction): Promise<string> {
    if (!interaction.guild) throw new Error('/voice join only works in a server')

    const member = await interaction.guild.members.fetch(this.targetUserId)
    const voiceChannel = member.voice.channel
    if (!voiceChannel) throw new Error('Target user is not currently in a voice channel in this server')
    if (voiceChannel.type !== ChannelType.GuildVoice && voiceChannel.type !== ChannelType.GuildStageVoice) {
      throw new Error('Target user is not in a joinable voice channel')
    }

    await this.join(voiceChannel, interaction.channelId)
    return `Joined ${voiceChannel.name}. Mode: listen (use /voice mode full to enable TTS replies).`
  }

  async join(voiceChannel: VoiceBasedChannel, textChannelId: string): Promise<void> {
    const guildId = voiceChannel.guild.id
    const existing = this.states.get(guildId)
    if (existing) this.leave(guildId)

    const me = voiceChannel.guild.members.me ?? await voiceChannel.guild.members.fetchMe()
    const perms = voiceChannel.permissionsFor(me)
    if (!perms?.has('Connect') || !perms?.has('Speak')) {
      throw new Error(`missing voice perms in #${voiceChannel.name} (need Connect + Speak)`)
    }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator as any,
      selfDeaf: false,
      selfMute: false,
    })

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000)
    } catch (err) {
      connection.destroy()
      throw new Error(`voice connection never became ready: ${err instanceof Error ? err.message : String(err)}`)
    }

    const state: VoiceState = {
      guildId,
      mode: 'listen',
      voiceChannelId: voiceChannel.id,
      textChannelId,
      connection,
      speaking: false,
      utteranceStartedAt: 0,
      chunks: [],
    }
    this.states.set(guildId, state)
    this.resetInactivityTimer(state)
    this.wireReceiver(state)

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ])
      } catch {
        if (this.states.get(guildId) !== state) return
        this.leave(guildId)
        // Auto-rejoin: fetch the channel and reconnect
        try {
          const ch = await this.client.channels.fetch(state.voiceChannelId)
          if (ch && (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice)) {
            await this.join(ch as VoiceBasedChannel, state.textChannelId)
          }
        } catch {
          // Rejoin failed — user will need to /voice join manually
        }
      }
    })
  }

  leave(guildId?: string): string {
    const targetGuildId = guildId ?? (this.states.size === 1 ? [...this.states.keys()][0] : undefined)
    if (!targetGuildId) return this.states.size === 0 ? 'Not connected to voice.' : 'Connected in multiple guilds; specify guild.'
    const state = this.states.get(targetGuildId)
    if (!state) return 'Not connected to voice.'

    if (state.inactivityTimer) clearTimeout(state.inactivityTimer)
    try { state.stream?.destroy?.() } catch {}
    try { state.connection.destroy() } catch {}
    this.states.delete(targetGuildId)
    return 'Left voice.'
  }

  guildIdForChat(chatId: string): string | null {
    return [...this.states.values()].find(s => s.textChannelId === chatId)?.guildId ?? null
  }

  currentMode(guildId: string | null | undefined): VoiceMode {
    if (!guildId) return 'full'
    return this.states.get(guildId)?.mode ?? 'listen'
  }

  modeStatus(guildId: string | null | undefined): string {
    if (!guildId || !this.states.has(guildId)) {
      return 'Not connected to voice. Current default mode: listen. Valid options: full, listen. Use `/voice join` first.'
    }
    return `Current voice mode: ${this.currentMode(guildId)}. Valid options: full, listen.`
  }

  setMode(guildId: string, mode: VoiceMode): string {
    const state = this.states.get(guildId)
    if (!state) return 'Not connected to voice. Use `/voice join` first, then try `/voice mode full` or `/voice mode listen`.'
    state.mode = mode
    return mode === 'full'
      ? 'Voice mode set to full: I will transcribe voice and speak replies.'
      : 'Voice mode set to listen: I will transcribe voice and reply in text only.'
  }

  isFull(guildId: string | null | undefined): boolean {
    if (!guildId) return true
    return this.states.get(guildId)?.mode !== 'listen'
  }

  async speakForChat(chatId: string, text: string): Promise<void> {
    const state = [...this.states.values()].find(s => s.textChannelId === chatId)
    if (!state || !text.trim()) return
    this.resetInactivityTimer(state)
    try {
      await speak(text, state.connection)
    } catch (err) {
      process.stderr.write(`fleet-discord: voice TTS failed: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  shutdown(): void {
    for (const guildId of [...this.states.keys()]) this.leave(guildId)
  }

  private wireReceiver(state: VoiceState): void {
    const receiver = state.connection.receiver

    const startListening = () => {
      if (this.states.get(state.guildId) !== state) return
      try { state.stream?.destroy?.() } catch {}

      // Subscribe proactively rather than waiting for receiver.speaking.on('start').
      // AfterSilence closes the stream ~400ms after the last packet, which catches
      // PTT release without needing the voice gateway Speaking opcode.
      const stream = receiver.subscribe(this.targetUserId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 400 },
      })
      state.stream = stream

      stream.on('data', (chunk: Buffer) => {
        if (!state.speaking) {
          state.speaking = true
          state.utteranceStartedAt = Date.now()
          state.chunks = []
        }
        this.resetInactivityTimer(state)
        state.chunks.push(Buffer.from(chunk))
      })

      stream.on('end', () => {
        void this.flushUtterance(state).then(() => {
          if (this.states.get(state.guildId) === state) startListening()
        })
      })

      stream.on('error', err => {
        process.stderr.write(`fleet-discord: voice receive stream error: ${err instanceof Error ? err.message : String(err)}\n`)
        if (this.states.get(state.guildId) === state) startListening()
      })
    }

    startListening()
  }

  private async flushUtterance(state: VoiceState): Promise<void> {
    if (!state.speaking) return
    state.speaking = false
    this.resetInactivityTimer(state)

    const elapsed = Date.now() - state.utteranceStartedAt
    const chunks = state.chunks
    state.chunks = []
    try { state.stream?.destroy?.() } catch {}
    state.stream = undefined

    if (elapsed < MIN_UTTERANCE_MS || chunks.length === 0) return

    const framedOpus = Buffer.concat(chunks.flatMap(chunk => {
      const len = Buffer.allocUnsafe(4)
      len.writeUInt32BE(chunk.length, 0)
      return [len, chunk]
    }))

    let text: string
    try {
      text = (await transcribe(framedOpus)).trim()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`fleet-discord: voice STT error: ${msg}\n`)
      return
    }

    if (!text || this.states.get(state.guildId) !== state) return

    let reply = ''
    try {
      reply = await callBrain(text)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`fleet-discord: voice brain error: ${msg}\n`)
    }

    // Notify the MCP layer (text path) regardless of mode — lets Discord
    // text channel see the transcript. In full mode we also speak the reply.
    await this.onTranscript({
      text,
      chatId: state.textChannelId,
      guildId: state.guildId,
      voiceChannelId: state.voiceChannelId,
    })

    if (reply && this.isFull(state.guildId)) {
      await this.speakForChat(state.textChannelId, reply)
    }
  }

  private resetInactivityTimer(state: VoiceState): void {
    if (state.inactivityTimer) clearTimeout(state.inactivityTimer)
    state.inactivityTimer = setTimeout(() => {
      if (this.states.get(state.guildId) !== state) return
      if (state.speaking) {
        this.resetInactivityTimer(state)
        return
      }
      process.stderr.write(`fleet-discord: auto-leaving voice after ${INACTIVITY_LEAVE_MS / 60000} minutes idle\n`)
      this.leave(state.guildId)
    }, INACTIVITY_LEAVE_MS)
    state.inactivityTimer.unref?.()
  }
}
