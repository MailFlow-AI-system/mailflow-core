export class SignupConflict extends Error {
  constructor() {
    super('The signup details are unavailable or the request has changed')
  }
}
