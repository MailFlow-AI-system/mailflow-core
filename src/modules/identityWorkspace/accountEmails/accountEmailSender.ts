import { createElement } from 'react'
import { render } from 'react-email'
import { Resend } from 'resend'

import type { AuthConfig } from '../infrastructure/auth/authConfig.js'
import { AccountVerifiedEmail } from './templates/AccountVerifiedEmail.js'
import { PasswordResetEmail } from './templates/PasswordResetEmail.js'
import { VerificationOtpEmail } from './templates/VerificationOtpEmail.js'
import type {
  AccountEmailDeliveryOptions,
  AccountEmailSender,
  AccountEmailTransport,
} from './types/accountEmail.js'

export type {
  AccountEmailDelivery,
  AccountEmailDeliveryOptions,
  AccountEmailMessage,
  AccountEmailSender,
  AccountEmailTransport,
} from './types/accountEmail.js'

function createResendTransport(apiKey: string): AccountEmailTransport {
  const resend = new Resend(apiKey)

  return async (delivery, options) => {
    const { error } = await resend.emails.send(delivery, options)
    if (error) throw new Error('Account email delivery failed')
  }
}

export function createAccountEmailSender(
  config: Pick<AuthConfig, 'resend'>,
  transport: AccountEmailTransport = createResendTransport(config.resend.apiKey),
): AccountEmailSender {
  return async (message) => {
    let subject: string
    let html: string
    let text: string
    let options: AccountEmailDeliveryOptions | undefined

    switch (message.kind) {
      case 'verification-otp':
        subject = 'Verify your MailFlow email'
        html = await render(createElement(VerificationOtpEmail, { otp: message.otp }))
        text = `Your MailFlow verification code is ${message.otp}. It expires in 5 minutes.`
        break
      case 'verified-welcome':
        subject = 'Your MailFlow account is verified'
        html = await render(
          createElement(AccountVerifiedEmail, {
            name: message.name,
            loginUrl: message.loginUrl,
          }),
        )
        text = `Welcome to MailFlow, ${message.name}. Your account is verified. Sign in: ${message.loginUrl}`
        options = { idempotencyKey: `account-welcome/${message.userId}` }
        break
      case 'password-reset':
        subject = 'Reset your MailFlow password'
        html = await render(
          createElement(PasswordResetEmail, { name: message.name, url: message.url }),
        )
        text = `Hello, ${message.name}. Reset your MailFlow password: ${message.url}`
        break
    }

    await transport(
      {
        from: `MailFlow <${config.resend.from}>`,
        to: message.to,
        subject,
        html,
        text,
      },
      options,
    )
  }
}
