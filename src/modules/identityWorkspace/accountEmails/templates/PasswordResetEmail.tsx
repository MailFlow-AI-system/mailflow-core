import { Button, Text } from 'react-email'

import { AccountEmailLayout } from './_components/AccountEmailLayout.js'

type PasswordResetEmailProps = { name: string; url: string }

export const PasswordResetEmail = Object.assign(
  function PasswordResetEmail({ name, url }: PasswordResetEmailProps) {
    return (
      <AccountEmailLayout preview="Reset your MailFlow password">
        <Text className="mb-2 mt-6 text-base">Hello, {name}</Text>
        <Text className="m-0 text-sm text-slate-600">
          Use the button below to choose a new password. The link expires in 1 hour and can only be
          used once.
        </Text>
        <Button
          href={url}
          className="mt-6 rounded-md bg-brand px-5 py-3 text-sm font-semibold text-white no-underline"
        >
          Reset password
        </Button>
        <Text className="mt-5 text-xs text-slate-500">If you prefer, copy this address: {url}</Text>
      </AccountEmailLayout>
    )
  },
  {
    PreviewProps: {
      name: 'Ana',
      url: 'http://localhost:8080/api/auth/reset-password/example-token',
    },
  },
)

export default PasswordResetEmail
