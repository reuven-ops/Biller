import { describe, expect, it } from 'vitest';
import {
  hostAllowed,
  loadEgress,
  loadJurisdictions,
  loadPayers,
  loadSources,
} from '../src/config.js';

describe('config loaders', () => {
  it('loads the 20 sources from brief section 6 plus cms_remit_guides (D14)', async () => {
    const sources = await loadSources();
    expect(sources).toHaveLength(21);
    const ids = sources.map((s) => s.id);
    expect(ids).toContain('cms_remit_guides');
    for (const id of [
      'cms_mcd',
      'cms_ncci_ptp',
      'cms_ncci_mue',
      'cms_ncci_manual',
      'cms_hcpcs',
      'cms_mpfs',
      'cms_icd10cm',
      'cms_iom',
      'cms_mln',
      'cms_telehealth_list',
      'cms_therapy',
      'fedreg',
      'oig_workplan',
      'mac_sites',
      'payer_policies',
      'client_contracts',
      'payer_call_notes',
      'remit_behavior',
      'ama_cpt',
      'x12_carc_rarc',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('tiers match brief section 6', async () => {
    const sources = await loadSources();
    const tierOf = new Map(sources.map((s) => [s.id, s.tier]));
    expect(tierOf.get('fedreg')).toBe(1);
    expect(tierOf.get('cms_ncci_ptp')).toBe(2);
    expect(tierOf.get('cms_mcd')).toBe(3);
    expect(tierOf.get('payer_policies')).toBe(4);
    expect(tierOf.get('client_contracts')).toBe(5);
    expect(tierOf.get('payer_call_notes')).toBe(6);
    expect(tierOf.get('remit_behavior')).toBe(7);
  });

  it('egress allowlist admits publisher domains and blocks everything else', async () => {
    const egress = await loadEgress();
    expect(hostAllowed('www.cms.gov', egress)).toBe(true);
    expect(hostAllowed('cms.gov', egress)).toBe(true);
    expect(hostAllowed('www.federalregister.gov', egress)).toBe(true);
    expect(hostAllowed('oig.hhs.gov', egress)).toBe(true);
    expect(hostAllowed('api.anthropic.com', egress)).toBe(true);
    expect(hostAllowed('example.com', egress)).toBe(false);
    expect(hostAllowed('evil-cms.gov.example.com', egress)).toBe(false);
    expect(hostAllowed('notcms.gov', egress)).toBe(false);
  });

  it('loads jurisdictions and payers hypothesis defaults', async () => {
    const j = await loadJurisdictions();
    expect(j.macs.map((m) => m.id)).toContain('JN');
    expect(j.default_state).toBe('FL');
    const payers = await loadPayers();
    expect(payers.length).toBeGreaterThanOrEqual(7);
  });
});
