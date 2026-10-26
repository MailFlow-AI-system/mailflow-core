import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createClamavScanner } from './clamav.js'

const servers: ReturnType<typeof createServer>[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})
describe('ClamAV scanner', () => {
  it('rejects stale signatures rather than marking content clean', async () => {
    const server = createServer((socket) => {
      socket.once('data', () => socket.end('ClamAV 1.0/123/Mon Jan  1 00:00:00 2001\0'))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No TCP address')
    const scanner = createClamavScanner({ host: '127.0.0.1', port: address.port, timeoutMs: 1000 })
    await expect(scanner.scan(Buffer.from('data'))).rejects.toThrow()
  })
})

it('validates private scanner configuration and bounded timeouts', async () => {
  const { loadClamavConfig } = await import('./clamav.js')
  expect(loadClamavConfig({ CLAMAV_HOST: 'clamav.internal', CLAMAV_PORT: '3310' })).toEqual({
    host: 'clamav.internal',
    port: 3310,
    timeoutMs: 30000,
  })
  expect(() =>
    loadClamavConfig({
      CLAMAV_HOST: 'clamav.internal',
      CLAMAV_PORT: '3310',
      CLAMAV_TIMEOUT_MS: '300000',
    }),
  ).toThrow()
})

it('scans the actual stream and returns infection without exposing scanner details', async () => {
  const commands: Buffer[] = []
  const server = createServer((socket) => {
    socket.once('data', (data: Buffer) => {
      commands.push(data)
      if (data.toString('utf8').startsWith('zVERSION'))
        socket.end(`ClamAV 1.4/123/${new Date().toUTCString()}\0`)
      else socket.end('stream: Test-Signature FOUND\0')
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No TCP address')
  const scanner = createClamavScanner({ host: '127.0.0.1', port: address.port, timeoutMs: 1000 })
  expect((await scanner.scan(Buffer.from('hello'))).result).toBe('infected')
  expect(commands[1]?.includes(Buffer.from('hello'))).toBe(true)
})

it('frames an empty file as a single INSTREAM terminator', async () => {
  const commands: Buffer[] = []
  const server = createServer((socket) => {
    socket.once('data', (data: Buffer) => {
      commands.push(data)
      if (data.toString('utf8').startsWith('zVERSION'))
        socket.end(`ClamAV 1.4/123/${new Date().toUTCString()}\0`)
      else socket.end('stream: OK\0')
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No TCP address')
  const scanner = createClamavScanner({ host: '127.0.0.1', port: address.port, timeoutMs: 1000 })
  expect((await scanner.scan(Buffer.alloc(0))).result).toBe('clean')
  expect(commands[1]).toEqual(Buffer.concat([Buffer.from('zINSTREAM\0'), Buffer.alloc(4)]))
})
