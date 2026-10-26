import { type Entry, fromBuffer, type ZipFile } from 'yauzl'

export class UnsupportedArchiveError extends Error {}

const maximumExpanded = 100_000_000
const maximumEntries = 10_000
const maximumDepth = 10
const maximumRatio = 100
const unsupportedExtension = /\.(?:7z|rar|gz|gzip|bz2|xz|zst|zstd|lz4|tar|tgz|tbz2|txz|cab|iso)$/i
const zipExtension = /\.(?:zip|docx|xlsx|pptx|odt|ods|odp|jar|apk)$/i

function isZip(bytes: Buffer) {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 3 && bytes[3] === 4) ||
      (bytes[2] === 5 && bytes[3] === 6) ||
      (bytes[2] === 7 && bytes[3] === 8))
  )
}
function unsupported(bytes: Buffer) {
  const hex = bytes.subarray(0, 8).toString('hex')
  return (
    hex.startsWith('1f8b') ||
    hex.startsWith('377abcaf271c') ||
    hex.startsWith('526172211a07') ||
    hex.startsWith('425a68') ||
    hex.startsWith('fd377a585a00') ||
    hex.startsWith('28b52ffd') ||
    hex.startsWith('04224d18') ||
    hex.startsWith('4d534346') ||
    (bytes.length > 262 && bytes.subarray(257, 262).toString('ascii') === 'ustar')
  )
}
function openZip(bytes: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) =>
    fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) =>
        error || !zip ? reject(error ?? new Error('Invalid archive')) : resolve(zip),
    ),
  )
}
function readEntry(zip: ZipFile, entry: Entry, deadline: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) return reject(error ?? new Error('Invalid archive entry'))
      const chunks: Buffer[] = []
      let size = 0
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (Date.now() > deadline || size > entry.uncompressedSize || size > maximumExpanded)
          stream.destroy(new Error('Archive entry too large'))
        else chunks.push(chunk)
      })
      stream.on('error', reject)
      stream.on('end', () => resolve(Buffer.concat(chunks)))
    }),
  )
}
export async function validateArchives(input: Buffer, filename = ''): Promise<void> {
  const budget = { expanded: 0, entries: 0, deadline: Date.now() + 25_000 }
  async function inspect(bytes: Buffer, name: string, depth: number): Promise<void> {
    if (Date.now() > budget.deadline) throw new Error('Archive inspection timed out')
    if (unsupported(bytes) || unsupportedExtension.test(name))
      throw new UnsupportedArchiveError('Unsupported archive format')
    if (!isZip(bytes)) {
      if (zipExtension.test(name)) throw new Error('Invalid ZIP archive')
      return
    }
    if (depth >= maximumDepth) throw new Error('Archive nesting too deep')
    const zip = await openZip(bytes)
    try {
      await new Promise<void>((resolve, reject) => {
        zip.on('error', reject)
        zip.on('end', resolve)
        zip.on('entry', (entry: Entry) => {
          void (async () => {
            if (Date.now() > budget.deadline) throw new Error('Archive inspection timed out')
            budget.entries++
            budget.expanded += entry.uncompressedSize
            if (
              budget.entries > maximumEntries ||
              budget.expanded > maximumExpanded ||
              entry.uncompressedSize > maximumExpanded ||
              (entry.uncompressedSize > 0 &&
                (entry.compressedSize === 0 ||
                  entry.uncompressedSize / entry.compressedSize > maximumRatio)) ||
              entry.isEncrypted()
            )
              throw new Error('Archive exceeds safety limits')
            if (!entry.fileName.endsWith('/'))
              await inspect(await readEntry(zip, entry, budget.deadline), entry.fileName, depth + 1)
            zip.readEntry()
          })().catch(reject)
        })
        zip.readEntry()
      })
    } finally {
      zip.close()
    }
  }
  await inspect(input, filename, 0)
}
