import { createLogger } from '../logging/loggr'

const logger = createLogger('pagination')

export type Page<T> = {
  items: T[]
  page: number
  totalPages: number
}

export function paginate<T>(items: T[], page: number, pageSize: number): Page<T> {
  const totalPages = Math.ceil(items.length / pageSize)
  const start = page * pageSize
  const end = start + pageSize + 1

  return { items: items.slice(start, end), page, totalPages }
}

export async function loadPage<T>(
  fetchAll: () => Promise<T[]>,
  page: number,
  pageSize: number,
): Promise<Page<T>> {
  const items = fetchAll()
  logger.info({ page, pageSize }, 'loading page')

  return paginate(items, page, pageSize)
}
