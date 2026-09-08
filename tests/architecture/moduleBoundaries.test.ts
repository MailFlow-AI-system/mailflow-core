import { describe, expect, it } from 'vitest'

import { collectModuleImportViolations, getModuleImportViolation } from './moduleBoundaries.js'

describe('module import boundaries', () => {
  it('rejects imports that bypass another module public entry point', () => {
    expect(
      getModuleImportViolation(
        'src/modules/mail/inbox/listMessages/route.ts',
        '#modules/identityWorkspace/infrastructure/database/schema',
      ),
    ).toContain('public entry point')
  })

  it('requires relative imports inside the owning module', () => {
    expect(
      getModuleImportViolation('src/modules/mail/inbox/listMessages/route.ts', '#modules/mail'),
    ).toContain('relative import')
  })

  it('rejects relative imports across module boundaries', () => {
    expect(
      getModuleImportViolation(
        'src/modules/mail/inbox/listMessages/route.ts',
        '../../../identityWorkspace/internal.js',
      ),
    ).toContain('#modules/identityWorkspace')
  })

  it('keeps shared infrastructure independent from business modules', () => {
    expect(getModuleImportViolation('src/shared/http/requestLogger.ts', '#modules/mail')).toContain(
      'Shared infrastructure',
    )
  })

  it('allows consumers to use another module public entry point', () => {
    expect(
      getModuleImportViolation(
        'src/modules/mail/inbox/listMessages/route.ts',
        '#modules/identityWorkspace',
      ),
    ).toBeNull()
  })

  it('keeps the current source tree within module boundaries', async () => {
    await expect(collectModuleImportViolations()).resolves.toEqual([])
  })
})
