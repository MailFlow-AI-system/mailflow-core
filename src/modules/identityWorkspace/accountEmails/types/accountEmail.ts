export type AccountEmailMessage =
  | { kind: 'verification-otp'; to: string; otp: string }
  | {
      kind: 'verified-welcome'
      to: string
      name: string
      userId: string
      loginUrl: string
    }
  | { kind: 'password-reset'; to: string; name: string; url: string }

export type AccountEmailDelivery = {
  from: string
  to: string
  subject: string
  html: string
  text: string
}

export type AccountEmailDeliveryOptions = { idempotencyKey?: string }

export type AccountEmailTransport = (
  delivery: AccountEmailDelivery,
  options?: AccountEmailDeliveryOptions,
) => Promise<void>

export type AccountEmailSender = (message: AccountEmailMessage) => Promise<void>
