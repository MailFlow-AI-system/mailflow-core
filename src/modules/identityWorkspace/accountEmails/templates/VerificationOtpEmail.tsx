import { Section, Text } from 'react-email'

import { AccountEmailLayout } from './_components/AccountEmailLayout.js'

type VerificationOtpEmailProps = { otp: string }

export const VerificationOtpEmail = Object.assign(
  function VerificationOtpEmail({ otp }: VerificationOtpEmailProps) {
    return (
      <AccountEmailLayout preview="Your MailFlow verification code">
        <Text className="mb-2 mt-6 text-base">Verify your email</Text>
        <Text className="m-0 text-sm text-slate-600">
          Use the code below to verify your email address.
        </Text>
        <Section className="my-6 rounded-lg bg-slate-100 px-4 py-5 text-center">
          <Text className="m-0 font-mono text-3xl font-bold tracking-widest">{otp}</Text>
        </Section>
        <Text className="m-0 text-sm text-slate-600">This code expires in 5 minutes.</Text>
      </AccountEmailLayout>
    )
  },
  { PreviewProps: { otp: '123456' } },
)

export default VerificationOtpEmail
