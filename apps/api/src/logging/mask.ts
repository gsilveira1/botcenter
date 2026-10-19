/**
 * Masks a phone number for logs and responses: `5511987654321` becomes `5511*****4321`.
 * The function keeps the first 4 and the last 4 digits of a number with 10 or more digits.
 * A shorter value keeps only its last 2 digits. Characters that are not digits are removed first.
 */
export function maskPhone(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length >= 10) {
    return `${digits.slice(0, 4)}${'*'.repeat(digits.length - 8)}${digits.slice(-4)}`;
  }
  if (digits.length > 2) {
    return `${'*'.repeat(digits.length - 2)}${digits.slice(-2)}`;
  }
  return '*'.repeat(Math.max(digits.length, 1));
}
