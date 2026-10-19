export function passwordStrength(password: string): { value: number; label: string; hint: string };
export function generatePassword(cryptoApi?: Pick<Crypto, 'getRandomValues'>): string;
