import { expect, it } from 'vitest'
import { createFixtureObjectStorage } from './objectStorage.js'

it('provides one-use uploads and immutable verified copies without an external service', async () => {
  const fixture = createFixtureObjectStorage('http://127.0.0.1:8083')
  const signed = await fixture.storage.presignPut('pending/example', 'text/plain')
  const upload = () =>
    new Request(signed.url, { method: 'PUT', headers: signed.headers, body: 'test' })
  expect((await fixture.upload(upload())).status).toBe(204)
  expect((await fixture.upload(upload())).status).toBe(403)
  await fixture.storage.copy('pending/example', 'final/example', 4, 'text/plain')
  await fixture.storage.delete('pending/example')
  expect(await fixture.storage.read('final/example', 'text/plain')).toEqual(Buffer.from('test'))
  await expect(fixture.storage.read('final/example', 'image/png')).rejects.toThrow('metadata')
})
it('rejects upload metadata mismatches and missing objects', async () => {
  const fixture = createFixtureObjectStorage('http://127.0.0.1:8083')
  const signed = await fixture.storage.presignPut('pending/example', 'text/plain')
  expect(
    (
      await fixture.upload(
        new Request(signed.url, {
          method: 'PUT',
          headers: { 'Content-Type': 'image/png' },
          body: 'test',
        }),
      )
    ).status,
  ).toBe(403)
  await expect(fixture.storage.copy('missing', 'final/example', 4, 'text/plain')).rejects.toThrow()
})
