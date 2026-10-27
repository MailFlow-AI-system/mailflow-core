import { describe, expect, it } from 'vitest'
import { finalAttachmentKey, parseMailFinalKey, temporaryAttachmentKey } from './attachmentKeys.js'

const id = '00000000-0000-4000-8000-000000000001'
const version = '00000000-0000-4000-8000-000000000002'
describe('Mail attachment object paths', () => {
  it('uses encoded workspace and immutable version segments without filenames', () => {
    const context = { workspaceId: 'workspace/a', userId: 'owner' }
    expect(temporaryAttachmentKey(context, id)).toBe(`uploads/workspace%2Fa/mail/attachments/${id}`)
    const key = finalAttachmentKey(context, id, version)
    expect(parseMailFinalKey(key)).toEqual({ workspaceId: 'workspace/a' })
  })
  it('recognizes exact legacy Mail prefixes without deriving workspace ownership', () => {
    expect(parseMailFinalKey(`objects/owners/${'a'.repeat(64)}/${id}/${version}`)).toEqual({
      workspaceId: null,
    })
    for (const key of [
      'objects/other',
      `workspaces/workspace-a/avatars/${id}`,
      `workspaces/%ZZ/mail/attachments/${id}/${version}`,
      `workspaces/workspace-a/mail/attachments/${id}/${version}/extra`,
    ])
      expect(parseMailFinalKey(key)).toBeNull()
  })
})
