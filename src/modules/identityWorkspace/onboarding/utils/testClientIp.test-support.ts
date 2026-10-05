import { randomInt } from 'node:crypto'

export function testClientIp() {
  return `198.18.${randomInt(256)}.${randomInt(256)}`
}
