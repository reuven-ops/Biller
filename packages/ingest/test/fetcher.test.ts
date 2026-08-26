import { describe, expect, it } from 'vitest';
import { EgressDeniedError, Fetcher } from '../src/fetcher.js';

describe('fetcher egress enforcement', () => {
  it('denies hosts not in config/egress.yaml', async () => {
    const fetcher = new Fetcher();
    await expect(fetcher.assertAllowed('https://example.com/file.zip')).rejects.toThrow(
      EgressDeniedError,
    );
    await expect(fetcher.assertAllowed('https://registry.npmjs.org/x')).rejects.toThrow(
      EgressDeniedError,
    );
  });

  it('allows the configured publisher domains', async () => {
    const fetcher = new Fetcher();
    await expect(
      fetcher.assertAllowed('https://www.cms.gov/files/zip/x.zip'),
    ).resolves.toBeUndefined();
    await expect(
      fetcher.assertAllowed('https://www.federalregister.gov/api/v1/documents.json'),
    ).resolves.toBeUndefined();
    await expect(fetcher.assertAllowed('https://oig.hhs.gov/reports')).resolves.toBeUndefined();
    await expect(fetcher.assertAllowed('https://x12.org/codes')).resolves.toBeUndefined();
  });

  it('fetchArtifact refuses a denied URL before any request', async () => {
    const fetcher = new Fetcher();
    await expect(fetcher.fetchArtifact('https://evil.example/x', 'test')).rejects.toThrow(
      EgressDeniedError,
    );
  });
});
