import { describe, expect, it } from 'vitest'
import { validateArchives } from './archiveValidation.js'

const normal =
  'UEsDBBQAAAAIAMqWWl0u+OLyEAAAAA4AAAAIAAAAaXRlbS5iaW7Lyy/KTcxRSM7PK0nNKwEAUEsBAhQDFAAAAAgAypZaXS744vIQAAAADgAAAAgAAAAAAAAAAAAAAIABAAAAAGl0ZW0uYmluUEsFBgAAAAABAAEANgAAADYAAAAAAA=='
const bomb =
  'UEsDBBQAAAAIAMqWWl0iBafcLwAAADB1AAAIAAAAaXRlbS5iaW7twTEBAAAAwqBs61/KEp5AAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8DFBLAQIUAxQAAAAIAMqWWl0iBafcLwAAADB1AAAIAAAAAAAAAAAAAACAAQAAAABpdGVtLmJpblBLBQYAAAAAAQABADYAAABVAAAAAAA='
const nestedGzip =
  'UEsDBBQAAAAIAMqWWl285ocMBgAAAAQAAAAIAAAAaXRlbS5iaW6T7+ZgAABQSwECFAMUAAAACADKllpdvOaHDAYAAAAEAAAACAAAAAAAAAAAAAAAgAEAAAAAaXRlbS5iaW5QSwUGAAAAAAEAAQA2AAAALAAAAAAA'
describe('archive safety limits', () => {
  it('accepts a normal ZIP and rejects excessive expansion', async () => {
    await expect(validateArchives(Buffer.from(normal, 'base64'))).resolves.toBeUndefined()
    await expect(validateArchives(Buffer.from(bomb, 'base64'))).rejects.toThrow()
  })
  it('rejects unsupported nested compressed formats', async () => {
    await expect(validateArchives(Buffer.from(nestedGzip, 'base64'))).rejects.toThrow()
  })
})
