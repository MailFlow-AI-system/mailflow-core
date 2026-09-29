import { Button, Text } from 'react-email'

import { AccountEmailLayout } from './_components/AccountEmailLayout.js'

type AccountVerifiedEmailProps = { name: string; loginUrl: string }

export const AccountVerifiedEmail = Object.assign(
  function AccountVerifiedEmail({ name, loginUrl }: AccountVerifiedEmailProps) {
    return (
      <AccountEmailLayout preview="Your MailFlow account is verified">
        <Text className="mb-2 mt-6 text-base">Welcome to MailFlow, {name}!</Text>
        <Text className="m-0 text-sm text-slate-600">
          Your email is verified and your account is ready to use.
        </Text>
        <Button
          href={loginUrl}
          className="mt-6 rounded-md bg-brand px-5 py-3 text-sm font-semibold text-white no-underline"
        >
          Go to your account
        </Button>
      </AccountEmailLayout>
    )
  },
  {
    PreviewProps: {
      name: 'Ana',
      loginUrl: 'http://localhost:3000/login',
    },
  },
)

export default AccountVerifiedEmail
