import { config as loadDotenv } from 'dotenv';

let loaded = false;

/** Loads .env once. Values already present in the process environment win. */
export function loadEnv(): void {
  if (!loaded) {
    loadDotenv({ quiet: true });
    loaded = true;
  }
}

export function requireEnv(name: string): string {
  loadEnv();
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function optionalEnv(name: string, fallback: string): string {
  loadEnv();
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

export function intEnv(name: string, fallback: number): number {
  const raw = optionalEnv(name, String(fallback));
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got: ${raw}`);
  }
  return parsed;
}
