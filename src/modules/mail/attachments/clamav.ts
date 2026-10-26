import { createConnection } from 'node:net'
import { z } from 'zod'
import type { AttachmentScanner } from './types.js'

export function loadClamavConfig(environment: Record<string, string | undefined>) {
  const config = z
    .object({
      CLAMAV_HOST: z.string().min(1),
      CLAMAV_PORT: z.coerce.number().int().min(1).max(65535),
      CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(30000),
    })
    .parse(environment)
  return { host: config.CLAMAV_HOST, port: config.CLAMAV_PORT, timeoutMs: config.CLAMAV_TIMEOUT_MS }
}

function exchange(host: string, port: number, timeoutMs: number, payload: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port })
    const chunks: Buffer[] = []
    let length = 0
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('Scanner timeout')))
    socket.on('connect', () => socket.write(payload))
    socket.on('error', reject)
    socket.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (length > 4096) {
        socket.destroy(new Error('Invalid scanner response'))
        return
      }
      chunks.push(chunk)
      if (chunk.includes(0)) {
        socket.destroy()
        resolve(Buffer.concat(chunks).toString('utf8').replace(/\0.*$/, ''))
      }
    })
    socket.on('end', () => reject(new Error('Incomplete scanner response')))
  })
}
export function createClamavScanner({
  host,
  port,
  timeoutMs = 30_000,
}: {
  host: string
  port: number
  timeoutMs?: number
}): AttachmentScanner {
  return {
    async scan(bytes) {
      const version = await exchange(host, port, timeoutMs, Buffer.from('zVERSION\0'))
      const match = /^ClamAV [^/]+\/\d+\/(.+)$/.exec(version)
      const timestamp = match?.[1] ? Date.parse(match[1]) : Number.NaN
      if (
        !Number.isFinite(timestamp) ||
        timestamp > Date.now() + 300_000 ||
        Date.now() - timestamp > 48 * 60 * 60 * 1000
      )
        throw new Error('Scanner signatures unavailable or stale')
      const length = Buffer.alloc(4)
      length.writeUInt32BE(bytes.length)
      const response = await exchange(
        host,
        port,
        timeoutMs,
        Buffer.concat([
          Buffer.from('zINSTREAM\0'),
          ...(bytes.length ? [length, bytes] : []),
          Buffer.alloc(4),
        ]),
      )
      if (response === 'stream: OK') return { result: 'clean', version }
      if (response.startsWith('stream: ') && response.endsWith(' FOUND'))
        return { result: 'infected', version }
      throw new Error('Scanner could not inspect attachment')
    },
  }
}
