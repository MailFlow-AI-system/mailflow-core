import type { ReactNode } from 'react'
import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  pixelBasedPreset,
  Tailwind,
  Text,
} from 'react-email'

type AccountEmailLayoutProps = {
  preview: string
  children: ReactNode
}

export function AccountEmailLayout({ preview, children }: AccountEmailLayoutProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Tailwind
        config={{
          presets: [pixelBasedPreset],
          theme: { extend: { colors: { brand: '#1570ef' } } },
        }}
      >
        <Body className="bg-slate-100 font-sans text-slate-900">
          <Container className="mx-auto my-8 w-full max-w-xl rounded-xl bg-white px-8 py-8">
            <Heading className="m-0 text-xl font-bold text-brand">MailFlow</Heading>
            {children}
            <Hr className="my-6 border-slate-200" />
            <Text className="m-0 text-sm text-slate-500">
              If you did not request this message, you can ignore it.
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  )
}
