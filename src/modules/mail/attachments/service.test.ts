import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createAttachmentService } from './service.js'
import type { AttachmentRecord } from './types.js'

const bytes = Buffer.from('hello')
const metadata = {
  filename: 'hello.txt',
  contentType: 'text/plain',
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
}
function setup() {
  let row: AttachmentRecord | undefined
  const repository = {
    create: vi.fn(async (input: AttachmentRecord) => {
      row = { ...input, status: 'pending' }
      return row
    }),
    get: vi.fn(async (owner: string, id: string) =>
      row?.userId === owner && row.id === id ? row : null,
    ),
    isAssociated: vi.fn(async () => false),
    isFinalKeyReferenced: vi.fn(async () => false),
    claimExpired: vi.fn(async () => []),
    deleteClaimed: vi.fn(async () => true),
    claimCompletion: vi.fn(async (owner: string, id: string, _token: string) =>
      row?.userId === owner && row.id === id ? row : null,
    ),
    finishCompletion: vi.fn(
      async (owner: string, id: string, _token: string, patch: Partial<AttachmentRecord>) => {
        if (row?.userId === owner && row.id === id) Object.assign(row, patch)
        return row ?? null
      },
    ),
  }
  const storage = {
    listOldFinalKeys: vi.fn(async () => ({ keys: [] })),
    presignPut: vi.fn(async () => ({
      url: 'https://storage.test/upload',
      headers: {},
      expiresAt: new Date('2030-01-01'),
    })),
    copy: vi.fn(async (_source: string, _target: string) => {}),
    read: vi.fn(async () => bytes),
    delete: vi.fn(async () => {}),
    presignGet: vi.fn(async () => 'https://storage.test/download'),
  }
  return {
    repository,
    storage,
    service: createAttachmentService({ repository, storage }),
  }
}
describe('attachment service', () => {
  it('completes immutable content verification without a scanner dependency', async () => {
    const { repository, storage } = setup()
    const service = createAttachmentService({ repository, storage })
    const started = await service.create('owner', metadata)
    const completed = await service.complete('owner', started.id)
    expect(completed).toMatchObject({ status: 'clean', finalKey: expect.any(String) })
    expect(completed).not.toHaveProperty('scanVersion')
    expect(completed).not.toHaveProperty('scannedAt')
    expect(storage.copy).toHaveBeenCalled()
    expect(storage.read).toHaveBeenCalled()
  })

  it('uses a separate final object and verifies bytes before availability', async () => {
    const { service, storage } = setup()
    const started = await service.create('owner', metadata)
    expect((await service.complete('owner', started.id)).status).toBe('clean')
    const [source, target] = storage.copy.mock.calls[0] ?? []
    expect(source).not.toBe(target)
    expect(storage.read).toHaveBeenCalledWith(target, metadata.contentType)
    expect(await service.get('other', started.id)).toBeNull()
  })
  it('rejects a checksum mismatch without making the object available', async () => {
    const { service, storage } = setup()
    const started = await service.create('owner', metadata)
    storage.read.mockResolvedValueOnce(Buffer.from('wrong'))
    expect((await service.complete('owner', started.id)).status).toBe('rejected')
    expect(await service.download('owner', started.id)).toBeNull()
  })
  it('retains a retryable state when object verification fails temporarily', async () => {
    const { service, storage } = setup()
    const started = await service.create('owner', metadata)
    storage.read.mockRejectedValueOnce(new Error('unavailable'))
    expect((await service.complete('owner', started.id)).status).toBe('error')
    expect((await service.complete('owner', started.id)).status).toBe('clean')
  })
})

it('does not resolve unverified, foreign, or corrupted attachments', async () => {
  const { service, storage } = setup()
  const started = await service.create('owner', metadata)
  await expect(service.resolveReferences('owner', [{ id: started.id }])).rejects.toThrow()
  await service.complete('owner', started.id)
  await expect(service.resolveReferences('other', [{ id: started.id }])).rejects.toThrow()
  storage.read.mockResolvedValueOnce(Buffer.from('wrong'))
  await expect(service.resolveReferences('owner', [{ id: started.id }])).rejects.toThrow()
  expect(await service.resolveReferences('owner', [{ id: started.id }])).toEqual([
    { filename: 'hello.txt', content: bytes.toString('base64') },
  ])
})

it('rejects excessive archive expansion before making an attachment available', async () => {
  const bomb = Buffer.from(
    'UEsDBBQAAAAIAMqWWl0iBafcLwAAADB1AAAIAAAAaXRlbS5iaW7twTEBAAAAwqBs61/KEp5AAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8DFBLAQIUAxQAAAAIAMqWWl0iBafcLwAAADB1AAAIAAAAAAAAAAAAAACAAQAAAABpdGVtLmJpblBLBQYAAAAAAQABADYAAABVAAAAAAA=',
    'base64',
  )
  const { service, storage } = setup()
  const started = await service.create('owner', {
    filename: 'bomb.zip',
    contentType: 'application/zip',
    size: bomb.length,
    sha256: createHash('sha256').update(bomb).digest('hex'),
  })
  storage.read.mockResolvedValueOnce(bomb)
  expect((await service.complete('owner', started.id)).status).toBe('rejected')
  expect(await service.download('owner', started.id)).toBeNull()
})

it('deletes only its own candidate if its completion lease is lost', async () => {
  const { service, storage, repository } = setup()
  const started = await service.create('owner', metadata)
  repository.finishCompletion.mockResolvedValueOnce(null)
  expect((await service.complete('owner', started.id)).status).toBe('pending')
  const destination = storage.copy.mock.calls[0]?.[1]
  expect(destination).toBeDefined()
  expect(storage.delete).toHaveBeenCalledWith(destination)
})

it('downloads only verified clean bytes for the owner', async () => {
  const { service, storage } = setup()
  const started = await service.create('owner', metadata)
  expect(await service.download('owner', started.id)).toBeNull()
  await service.complete('owner', started.id)
  expect(await service.download('other', started.id)).toBeNull()
  expect(await service.download('owner', started.id)).toEqual(bytes)
  storage.read.mockResolvedValueOnce(Buffer.from('wrong'))
  await expect(service.download('owner', started.id)).rejects.toThrow()
})

it('bounds concurrent content verification and archive inspection', async () => {
  const { service, storage } = setup()
  const started = await service.create('owner', metadata)
  let release: (() => void) | undefined
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  storage.copy.mockImplementation(async () => blocked)
  const first = service.complete('owner', started.id)
  const second = service.complete('owner', started.id)
  await vi.waitFor(() => expect(storage.copy).toHaveBeenCalledTimes(2))
  await expect(service.complete('owner', started.id)).rejects.toThrow('busy')
  release?.()
  await Promise.all([first, second])
})

it('exposes expired status only for unassociated attachments', async () => {
  const { service, repository } = setup()
  const started = await service.create('owner', metadata)
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 60 * 60 * 1000)
  try {
    expect(await service.get('owner', started.id)).toMatchObject({
      status: 'expired',
      associated: false,
    })
    expect((await service.complete('owner', started.id)).status).toBe('expired')
    repository.isAssociated.mockResolvedValue(true)
    expect(await service.get('owner', started.id)).toMatchObject({
      status: 'pending',
      associated: true,
    })
  } finally {
    now.mockRestore()
  }
})

it('verifies zero-byte attachments', async () => {
  const { service, storage } = setup()
  const empty = Buffer.alloc(0)
  const started = await service.create('owner', {
    ...metadata,
    size: 0,
    sha256: createHash('sha256').update(empty).digest('hex'),
  })
  storage.read.mockResolvedValue(empty)
  expect((await service.complete('owner', started.id)).status).toBe('clean')
  expect(await service.resolveReferences('owner', [{ id: started.id }])).toEqual([
    { filename: metadata.filename, content: '' },
  ])
})
