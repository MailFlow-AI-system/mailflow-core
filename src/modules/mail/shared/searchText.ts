/**
 * PostgreSQL text cannot hold NUL, so a search or cursor value containing it could only fail
 * in the database; schemas reject it up front as an invalid query instead.
 */
export const hasNoNul = (value: string) => !value.includes('\u0000')
