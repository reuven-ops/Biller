// Loaders for the YAML files under config/. URLs and domain lists live in config,
// not code (brief section 6 rule).
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'config');

export interface SourceConfig {
  id: string;
  name: string;
  publisher: string;
  kind: 'download' | 'html' | 'pdf' | 'upload' | 'import';
  cadence_days: number;
  tier: number;
  license_required: boolean;
  enabled: boolean;
  base_url: string;
  config?: Record<string, unknown>;
}

export interface EgressConfig {
  allow: string[];
}

export interface MacConfig {
  id: string;
  name: string;
  states: string[];
  domains: string[];
}

export interface JurisdictionsConfig {
  macs: MacConfig[];
  default_mac: string;
  default_state: string;
}

export interface PayerConfig {
  id: string;
  name: string;
  lob: string[];
  domains: string[];
}

async function readYaml<T>(name: string, dir: string): Promise<T> {
  const raw = await readFile(join(dir, name), 'utf8');
  return parse(raw) as T;
}

export async function loadSources(dir: string = CONFIG_DIR): Promise<SourceConfig[]> {
  const parsed = await readYaml<{ sources: SourceConfig[] }>('sources.yaml', dir);
  return parsed.sources;
}

export async function loadEgress(dir: string = CONFIG_DIR): Promise<EgressConfig> {
  return readYaml<EgressConfig>('egress.yaml', dir);
}

export async function loadJurisdictions(dir: string = CONFIG_DIR): Promise<JurisdictionsConfig> {
  return readYaml<JurisdictionsConfig>('jurisdictions.yaml', dir);
}

export async function loadPayers(dir: string = CONFIG_DIR): Promise<PayerConfig[]> {
  const parsed = await readYaml<{ payers: PayerConfig[] }>('payers.yaml', dir);
  return parsed.payers;
}

export interface ProviderTypeConfig {
  id: string;
  name: string;
}

export async function loadProviderTypes(dir: string = CONFIG_DIR): Promise<ProviderTypeConfig[]> {
  const parsed = await readYaml<{ provider_types: ProviderTypeConfig[] }>(
    'provider_types.yaml',
    dir,
  );
  return parsed.provider_types;
}

/**
 * True when the hostname is allowed by the egress allowlist. A leading "*." entry
 * matches any subdomain; a bare domain matches itself and any subdomain, mirroring
 * how the firewall rule will be written.
 */
export function hostAllowed(hostname: string, egress: EgressConfig): boolean {
  const host = hostname.toLowerCase();
  for (const entry of egress.allow) {
    const rule = entry.toLowerCase();
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(2);
      if (host === suffix || host.endsWith(`.${suffix}`)) return true;
    } else if (host === rule || host.endsWith(`.${rule}`)) {
      return true;
    }
  }
  return false;
}
