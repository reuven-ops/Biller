// Per-run evidence registry (brief section 9): every tool result registers evidence
// records; the composer can cite only evidence_ids issued during the run, enforced in
// code at verification time (brief section 11.5).
import { randomUUID } from 'node:crypto';
import type { Tier } from '@advisor/db';

export interface EvidenceRecord {
  evidence_id: string;
  document_id: string;
  external_id: string;
  title: string;
  doc_type: string;
  publisher: string;
  tier: Tier;
  section_path: string;
  text: string;
  effective_date: string | null;
  retired_date: string | null;
  retrieved_at: string;
  version_hash: string;
  url: string | null;
  client_id: string | null;
}

export class EvidenceRegistry {
  private readonly byId = new Map<string, EvidenceRecord>();

  register(record: Omit<EvidenceRecord, 'evidence_id'>): EvidenceRecord {
    const withId: EvidenceRecord = { evidence_id: `ev_${randomUUID().slice(0, 12)}`, ...record };
    this.byId.set(withId.evidence_id, withId);
    return withId;
  }

  get(evidenceId: string): EvidenceRecord | undefined {
    return this.byId.get(evidenceId);
  }

  has(evidenceId: string): boolean {
    return this.byId.has(evidenceId);
  }

  all(): EvidenceRecord[] {
    return [...this.byId.values()];
  }

  /** Total characters of evidence text issued so far (for the 40K token context cap). */
  totalTextLength(): number {
    let n = 0;
    for (const r of this.byId.values()) n += r.text.length;
    return n;
  }
}
