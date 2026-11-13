const regionsWithoutUnpaidGeminiAccess = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IS", "IE", "IT", "LV", "LI", "LT", "LU", "MT", "NL", "NO", "PL",
  "PT", "RO", "SK", "SI", "ES", "SE", "CH", "GB",
]);

export function unpaidGeminiRegionRestricted(country: string | undefined): boolean {
  return Boolean(country && regionsWithoutUnpaidGeminiAccess.has(country.toUpperCase()));
}

export function requestCountry(request: Request): string | undefined {
  return (request as Request & { cf?: { country?: string } }).cf?.country;
}
