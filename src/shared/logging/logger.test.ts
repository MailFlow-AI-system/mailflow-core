import { once } from 'node:events'
import { Worker } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'

import type { AppConfig } from '../config/env.js'
import { createLogger, shutdownLogger } from './logger.js'

describe('logger lifecycle', () => {
  it('waits for the OTLP transport to export logs during shutdown', async () => {
    const exported = new Int32Array(new SharedArrayBuffer(4))
    const collector = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads')
       const { createServer } = require('node:http')
       const exported = new Int32Array(workerData)
       const server = createServer(async (request, response) => {
         const chunks = []
         for await (const chunk of request) chunks.push(chunk)
         if (request.url === '/v1/logs' &&
             Buffer.concat(chunks).includes(Buffer.from('Last log before shutdown'))) {
           Atomics.store(exported, 0, 1)
         }
         response.writeHead(200).end()
       })
       server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port))`,
      { eval: true, workerData: exported.buffer },
    )
    const [port] = await once(collector, 'message')

    const previousEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${port}`
    try {
      const config = {
        appEnv: 'test',
        databaseUrl: 'postgresql://localhost/test',
        host: '127.0.0.1',
        port: 8080,
        logLevel: 'info',
        apiDocsEnabled: false,
        serviceVersion: 'test',
        otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
        otelTraceSampleRate: 1,
        serviceInstanceId: 'test-instance',
      } satisfies AppConfig
      const logger = createLogger(config)
      logger.info('Last log before shutdown')

      await shutdownLogger(logger)

      expect(Atomics.load(exported, 0)).toBe(1)
    } finally {
      if (previousEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousEndpoint
      await collector.terminate()
    }
  }, 10_000)
})
