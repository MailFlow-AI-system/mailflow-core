import { z } from '@hono/zod-openapi'

/** Sort options shared by the Inbox, Sent and Drafts lists. */
export const mailListSorts = [
  'newest',
  'oldest',
  'sender-asc',
  'sender-desc',
  'subject-asc',
  'subject-desc',
] as const
export type MailListSort = (typeof mailListSorts)[number]

export const mailListSortSchema = z.enum(mailListSorts).default('newest').openapi({
  description:
    'List order; defaults to newest. Sender options sort by the displayed correspondent and subject options by subject, both case-insensitively, with the id as tie-break.',
})

export type MailListOrder = { field: 'date' | 'sender' | 'subject'; direction: 'asc' | 'desc' }

const orders: Record<MailListSort, MailListOrder> = {
  newest: { field: 'date', direction: 'desc' },
  oldest: { field: 'date', direction: 'asc' },
  'sender-asc': { field: 'sender', direction: 'asc' },
  'sender-desc': { field: 'sender', direction: 'desc' },
  'subject-asc': { field: 'subject', direction: 'asc' },
  'subject-desc': { field: 'subject', direction: 'desc' },
}

/**
 * Resolves a sort to a fixed field and direction. Repositories map these to constant SQL
 * fragments, so request values never reach ORDER BY text.
 */
export function mailListOrder(sort: MailListSort): MailListOrder {
  const order = Object.hasOwn(orders, sort) ? orders[sort] : undefined
  if (!order) throw new TypeError('Unsupported mail list sort')
  return order
}
