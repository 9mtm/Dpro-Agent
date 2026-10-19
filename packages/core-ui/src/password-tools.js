/** Local-only guidance. This is not a breach check or an installation-security score. */
export function passwordStrength(password) {
  if (!password) return { value: 0, label: 'Not entered', hint: 'Use a unique password with at least 12 characters.' };
  if (password.length < 12 || /^(.)\1+$/.test(password) || /password|123456|qwerty|letmein|admin/i.test(password)) return { value: 1, label: 'Weak', hint: 'Use a longer, unique password or generate one.' };
  const groups = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(r => r.test(password)).length;
  if (password.length >= 20 && new Set(password).size >= 10 && groups >= 3) return { value: 3, label: 'Strong', hint: 'Save this unique password in your password manager.' };
  return { value: 2, label: 'Fair', hint: 'A longer unique passphrase or generated password is stronger.' };
}
export function generatePassword(cryptoApi = globalThis.crypto) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = cryptoApi.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, n => alphabet[n & 63]).join('');
}
