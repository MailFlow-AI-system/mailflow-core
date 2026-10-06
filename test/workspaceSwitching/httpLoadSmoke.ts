import assert from 'node:assert/strict'
import { loadFixtureSchema, loadPageSchema, loadSignInSchema } from './loadSchemas.js'
import { summarizeLoad } from './loadStats.js'
import type { HttpLoadSample } from './loadTypes.js'

const origin = 'http://127.0.0.1:8083'
const data = loadFixtureSchema.parse(await (await fetch(`${origin}/__fixture`)).json())
const reset = await fetch(`${origin}/__fixture/control`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-fixture-control': data.controlKey },
  body: JSON.stringify({ action: 'reset' }),
})
assert.equal(reset.status, 200)

async function signIn(email: string) {
  const response = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `http://${data.host}:3003` },
    body: JSON.stringify({ email, password: data.password }),
  })
  assert.equal(response.status, 200, 'Synthetic identity sign-in must succeed')
  const user = loadSignInSchema.parse(await response.json()).user
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  assert.ok(cookie.includes('better-auth.session_token='))
  return { id: user.id, cookie }
}

const [actor, observer] = await Promise.all([signIn(data.email), signIn(data.otherEmail)])
async function sample(id: string, cookie: string, forbiddenId: string): Promise<HttpLoadSample> {
  const started = performance.now()
  const response = await fetch(`${origin}/api/v1/workspaces`, {
    headers: { Cookie: cookie, 'X-Workspace-Identity': id },
    signal: AbortSignal.timeout(5000),
  })
  assert.equal(response.headers.get('x-workspace-identity'), id)
  if (response.status === 200) {
    const page = loadPageSchema.parse(await response.json())
    assert.ok(
      !page.items.some((item) => item.id === forbiddenId),
      'Unrelated workspace must not leak',
    )
  } else {
    await response.arrayBuffer()
    assert.equal(response.status, 429)
    const retryAfter = Number(response.headers.get('retry-after'))
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60)
  }
  return { status: response.status, durationMs: Math.round(performance.now() - started) }
}

// Finite local workload. Thresholds are fixed before execution, not fitted to results.
const started = performance.now()
const [burst, observations] = await Promise.all([
  Promise.all(Array.from({ length: 150 }, () => sample(actor.id, actor.cookie, data.unrelatedId))),
  Promise.all(
    Array.from({ length: 20 }, () => sample(observer.id, observer.cookie, data.currentId)),
  ),
])
const elapsedMs = Math.round(performance.now() - started)
const result = { elapsedMs, burst: summarizeLoad(burst), observer: summarizeLoad(observations) }
console.info(JSON.stringify(result))
assert.equal(result.burst.accepted, 120)
assert.equal(result.burst.limited, 30)
assert.equal(result.burst.unexpected, 0)
assert.equal(result.observer.accepted, 20)
assert.equal(result.observer.limited, 0)
assert.ok(result.observer.p95Ms < 2000, 'Observer p95 must remain below the local 2s ceiling')
assert.ok(elapsedMs < 5000, 'Finite workload must finish within the local 5s ceiling')
const after = loadFixtureSchema.parse(await (await fetch(`${origin}/__fixture`)).json())
assert.equal(after.selections, 0)
assert.equal(after.globalMailCalls, 0)
assert.equal(after.preference, null)
assert.equal(after.hasActiveOrganization, false)
