export function waitForShutdown(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const keepAlive = setInterval(() => undefined, 60_000)

    const onSignal = (signal: NodeJS.Signals) => {
      clearInterval(keepAlive)
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      resolve(signal)
    }

    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
  })
}
