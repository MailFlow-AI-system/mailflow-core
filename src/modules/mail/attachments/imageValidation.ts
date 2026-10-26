export function validImageContent(contentType: string, bytes: Buffer): boolean {
  switch (contentType) {
    case 'image/png':
      return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    case 'image/gif':
      return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
    case 'image/webp':
      return (
        bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
        bytes.subarray(8, 12).toString('ascii') === 'WEBP'
      )
    default:
      return false
  }
}
