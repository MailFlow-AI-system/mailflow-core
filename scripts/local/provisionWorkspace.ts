import { randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import type { Pool } from 'pg'

export async function createVerifiedUser(
  pool: Pool,
  input: { name: string; email: string; password: string },
) {
  const id = randomUUID()
  const password = await hashPassword(input.password)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      'insert into identity_workspace."user"(id,name,email,email_verified,created_at,updated_at) values($1,$2,$3,true,now(),now())',
      [id, input.name, input.email],
    )
    await client.query(
      "insert into identity_workspace.account(id,account_id,provider_id,user_id,password,created_at,updated_at) values($1,$2,'credential',$2,$3,now(),now())",
      [randomUUID(), id, password],
    )
    await client.query('COMMIT')
    return { id }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function createSampleWorkspace(
  pool: Pool,
  input: { id: string; name: string; slug: string; ownerId: string },
) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      'insert into identity_workspace.organization(id,name,slug,created_at) values($1,$2,$3,now())',
      [input.id, input.name, input.slug],
    )
    await client.query(
      "insert into identity_workspace.member(id,organization_id,user_id,role,created_at) values($1,$2,$3,'owner',now())",
      [randomUUID(), input.id, input.ownerId],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
