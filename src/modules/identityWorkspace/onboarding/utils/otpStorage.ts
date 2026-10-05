import type { AuthProvisioningOptions } from '../../infrastructure/types/authOptions.js'
import type { OnboardingCipher } from '../types.js'

export function createProtectedOtpStorage(
  cipher: OnboardingCipher,
): NonNullable<AuthProvisioningOptions['otpStorage']> {
  return {
    encrypt: async (otp) => cipher.seal(otp, 'auth-email-otp'),
    // Existing codes remain valid during the coordinated five-minute cutover.
    decrypt: async (value) =>
      /^\d{6}$/.test(value) ? value : cipher.open(value, 'auth-email-otp'),
  }
}
